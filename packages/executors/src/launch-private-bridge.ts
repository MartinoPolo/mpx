import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { ExecutionError } from './index.js';
import type { JsonValue } from '@mpx/core';
import {
  PHASE_F2_REMOTE_TOOL_PATHS,
  type ProductionRemoteToolClient,
  type SandboxHandleBinding,
} from './production-remote.js';

const MAX_FRAME_BYTES = 1024 * 1024,
  REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function fail(code: string, message: string): never {
  throw new ExecutionError(code, message);
}
export interface LaunchPrivateBridgeConfig {
  readonly schemaVersion: 1;
  readonly endpoint: string;
  readonly nonce: string;
  readonly launchKey: string;
  readonly identity: { readonly name: string; readonly domain: 'personal' | 'work' };
  readonly planKey: string;
  readonly runtimeToolInventorySha256: string;
  readonly capabilitySha256: string;
}
export interface LaunchPrivateBridge {
  readonly config: LaunchPrivateBridgeConfig;
  readonly stateFile: string;
  close(): Promise<void>;
}
export interface LaunchPrivateBridgeStartupDependencies {
  readonly listen?: (server: Server) => Promise<void>;
  readonly writeState?: (file: string, data: string) => Promise<void>;
  readonly restrictAcl?: (target: string) => Promise<void>;
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','),
  );
}
function safeError(error: unknown): { code: string; message: string } {
  const code = error instanceof ExecutionError ? error.code : 'BRIDGE_REMOTE_FAILED';
  return { code, message: code };
}
function parseFrame(buffer: Buffer): Record<string, unknown> {
  if (buffer.length > MAX_FRAME_BYTES) {
    fail('BRIDGE_FRAME_INVALID', 'Bridge message exceeds its bound.');
  }
  const text = buffer.toString('utf8');
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    fail('BRIDGE_FRAME_INVALID', 'Bridge requires one NDJSON frame.');
  }
  try {
    const value = JSON.parse(text.slice(0, -1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error();
    }
    return value;
  } catch {
    fail('BRIDGE_FRAME_INVALID', 'Bridge message is invalid.');
  }
}
function sameBinding(value: Record<string, unknown>, config: LaunchPrivateBridgeConfig): boolean {
  return (
    value.nonce === config.nonce &&
    value.launchKey === config.launchKey &&
    value.planKey === config.planKey &&
    value.runtimeToolInventorySha256 === config.runtimeToolInventorySha256 &&
    value.capabilitySha256 === config.capabilitySha256 &&
    exact(value.identity, ['name', 'domain']) &&
    value.identity.name === config.identity.name &&
    value.identity.domain === config.identity.domain
  );
}
function privateRoot(root: string): Promise<string> {
  return (async () => {
    if (!path.isAbsolute(root)) {
      fail('BRIDGE_STATE_INVALID', 'Bridge state root must be absolute.');
    }
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('BRIDGE_STATE_INVALID', 'Bridge state root is unsafe.');
    }
    return realpath(root);
  })();
}
async function restrictAcl(target: string): Promise<void> {
  await chmod(target, (await lstat(target)).isDirectory() ? 0o700 : 0o600);
  if (process.platform !== 'win32') {
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT,
    user = process.env.USERNAME,
    domain = process.env.USERDOMAIN;
  if (!systemRoot || !user) {
    fail('BRIDGE_STATE_INVALID', 'Windows private bridge ACL identity is unavailable.');
  }
  const principal = domain ? `${domain}\\${user}` : user,
    executable = path.join(systemRoot, 'System32', 'icacls.exe');
  await new Promise<void>((resolve, reject) =>
    execFile(
      executable,
      [target, '/inheritance:r', '/grant:r', `${principal}:(F)`],
      { shell: false, windowsHide: true, timeout: 5000 },
      (error) =>
        error
          ? reject(
              new ExecutionError(
                'BRIDGE_STATE_INVALID',
                'Windows private bridge ACL could not be restricted.',
              ),
            )
          : resolve(),
    ),
  );
}
async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function startLaunchPrivateBridge(input: {
  stateRoot: string;
  binding: Readonly<SandboxHandleBinding>;
  client: ProductionRemoteToolClient;
  requestTimeoutMs?: number;
  dependencies?: LaunchPrivateBridgeStartupDependencies;
}): Promise<LaunchPrivateBridge> {
  const canonicalRoot = await privateRoot(input.stateRoot),
    directory = path.join(canonicalRoot, 'launch-private', input.binding.launchKey),
    deps = input.dependencies ?? {};
  let startupServer: Server | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await (deps.restrictAcl ?? restrictAcl)(directory);
    if (
      (await lstat(directory)).isSymbolicLink() ||
      !path.resolve(await realpath(directory)).startsWith(path.resolve(canonicalRoot) + path.sep)
    ) {
      fail('BRIDGE_STATE_INVALID', 'Bridge state escaped its private root.');
    }
    const nonce = randomBytes(32).toString('hex'),
      seen = new Set<string>(),
      sockets = new Set<Socket>(),
      pending = new Set<Promise<void>>(),
      controllers = new Map<string, AbortController>();
    let closing = false;
    let config!: LaunchPrivateBridgeConfig;
    const server: Server = (startupServer = createServer((socket) => {
      if (closing) {
        socket.destroy();
        return;
      }
      if (
        socket.remoteAddress !== '127.0.0.1' &&
        socket.remoteAddress !== '::ffff:127.0.0.1' &&
        socket.remoteAddress !== '::1'
      ) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      let bytes = Buffer.alloc(0),
        activeRequestId: string | undefined;
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > MAX_FRAME_BYTES) {
          socket.end(
            `${JSON.stringify({ schemaVersion: 1, kind: 'error', code: 'BRIDGE_FRAME_INVALID' })}\n`,
          );
          return;
        }
        if (!bytes.includes(10)) {
          return;
        }
        const work = (async () => {
          try {
            const frame = parseFrame(bytes);
            if (!sameBinding(frame, config)) {
              fail(
                'BRIDGE_ATTESTATION_FAILED',
                'Bridge peer, nonce, or launch binding did not attest.',
              );
            }
            if (
              frame.schemaVersion !== 1 ||
              typeof frame.requestId !== 'string' ||
              !REQUEST_ID.test(frame.requestId)
            ) {
              fail('BRIDGE_FRAME_INVALID', 'Bridge request shape is invalid.');
            }
            if (frame.kind === 'cancel') {
              const controller = controllers.get(frame.requestId);
              if (!controller) {
                fail('REMOTE_REQUEST_UNKNOWN', 'Cannot cancel an unknown bridge request.');
              }
              controller.abort();
              socket.end(
                `${JSON.stringify({ schemaVersion: 1, kind: 'cancelled', requestId: frame.requestId })}\n`,
              );
              return;
            }
            if (
              frame.kind !== 'request' ||
              typeof frame.toolPath !== 'string' ||
              !('input' in frame)
            ) {
              fail('BRIDGE_FRAME_INVALID', 'Bridge request shape is invalid.');
            }
            if (seen.has(frame.requestId)) {
              fail('REMOTE_REPLAY', 'Bridge request was replayed.');
            }
            seen.add(frame.requestId);
            const controller = new AbortController();
            controllers.set(frame.requestId, controller);
            activeRequestId = frame.requestId;
            const timeoutMs = Math.min(input.requestTimeoutMs ?? 120_000, 120_000);
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new ExecutionError('BRIDGE_TIMEOUT', 'Bridge request timed out.'));
              }, timeoutMs);
              timer.unref?.();
            });
            const output = await Promise.race([
              input.client.execute(frame.toolPath, frame.input, {
                requestId: frame.requestId,
                signal: controller.signal,
              }),
              timeout,
            ]);
            controllers.delete(frame.requestId);
            if (timer) {
              clearTimeout(timer);
            }
            socket.end(
              `${JSON.stringify({ schemaVersion: 1, kind: 'result', requestId: frame.requestId, output })}\n`,
            );
          } catch (error) {
            const safe = safeError(error);
            socket.end(`${JSON.stringify({ schemaVersion: 1, kind: 'error', ...safe })}\n`);
          }
        })();
        pending.add(work);
        void work.finally(() => pending.delete(work));
      });
      socket.on('close', () => {
        sockets.delete(socket);
        if (activeRequestId) {
          controllers.get(activeRequestId)?.abort();
        }
      });
    }));
    await (deps.listen ?? listenLoopback)(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      fail('BRIDGE_UNAVAILABLE', 'Bridge endpoint was not created.');
    }
    config = Object.freeze({
      schemaVersion: 1,
      endpoint: `tcp://127.0.0.1:${address.port}`,
      nonce,
      launchKey: input.binding.launchKey,
      identity: Object.freeze({ ...input.binding.identity }),
      planKey: input.binding.planKey,
      runtimeToolInventorySha256: input.binding.runtimeToolInventorySha256,
      capabilitySha256: input.binding.capabilitySha256,
    });
    const stateFile = path.join(directory, `${randomUUID()}.json`);
    await (deps.writeState ?? ((file, data) => writeFile(file, data, { flag: 'wx', mode: 0o600 })))(
      stateFile,
      `${JSON.stringify(config)}\n`,
    );
    await (deps.restrictAcl ?? restrictAcl)(stateFile);
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      config,
      stateFile,
      close: () =>
        (closePromise ??= (async () => {
          closing = true;
          const serverClosed = closeServer(server);
          for (const controller of controllers.values()) {
            controller.abort();
          }
          for (const socket of sockets) {
            socket.destroy();
          }
          await serverClosed;
          await Promise.allSettled(pending);
          await rm(stateFile, { force: true });
          await rm(directory, { recursive: true, force: true });
        })()),
    });
  } catch (error) {
    await closeServer(startupServer);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function connectLaunchPrivateBridge(config: LaunchPrivateBridgeConfig): {
  execute(
    path: string,
    input: unknown,
    options?: { requestId?: string; signal?: AbortSignal },
  ): Promise<JsonValue>;
  attestation(): { toolPaths: readonly string[]; digest: string; inventorySha256: string };
} {
  const seen = new Set<string>();
  return {
    attestation: () => ({
      toolPaths: PHASE_F2_REMOTE_TOOL_PATHS,
      digest: config.capabilitySha256,
      inventorySha256: config.runtimeToolInventorySha256,
    }),
    execute: async (toolPath, input, options = {}) => {
      const requestId = options.requestId ?? randomUUID();
      if (seen.has(requestId)) {
        fail('REMOTE_REPLAY', 'Bridge request was replayed.');
      }
      seen.add(requestId);
      if (options.signal?.aborted) {
        fail('REMOTE_CANCELLED', 'Bridge request was cancelled.');
      }
      const match = /^tcp:\/\/127\.0\.0\.1:(\d{1,5})$/u.exec(config.endpoint);
      if (!match) {
        fail('BRIDGE_UNAVAILABLE', 'Bridge endpoint is invalid.');
      }
      const frame = {
        schemaVersion: 1,
        kind: 'request',
        requestId,
        nonce: config.nonce,
        launchKey: config.launchKey,
        identity: config.identity,
        planKey: config.planKey,
        runtimeToolInventorySha256: config.runtimeToolInventorySha256,
        capabilitySha256: config.capabilitySha256,
        toolPath,
        input,
      };
      const encoded = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
        fail('BRIDGE_FRAME_INVALID', 'Bridge message exceeds its bound.');
      }
      return new Promise<JsonValue>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: Number(match[1]) });
        let bytes = Buffer.alloc(0),
          settled = false;
        const done = (error?: unknown, value?: JsonValue) => {
          if (settled) {
            return;
          }
          settled = true;
          socket.destroy();
          if (error) {
            reject(error);
          } else {
            resolve(value!);
          }
        };
        socket.once('error', () =>
          done(new ExecutionError('BRIDGE_UNAVAILABLE', 'Launch-private bridge is unavailable.')),
        );
        socket.once('connect', () => socket.write(encoded));
        options.signal?.addEventListener(
          'abort',
          () => done(new ExecutionError('REMOTE_CANCELLED', 'Bridge request was cancelled.')),
          { once: true },
        );
        socket.on('data', (chunk) => {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > MAX_FRAME_BYTES) {
            return done(
              new ExecutionError('BRIDGE_FRAME_INVALID', 'Bridge response exceeds its bound.'),
            );
          }
          if (!bytes.includes(10)) {
            return;
          }
          try {
            const value = parseFrame(bytes);
            if (value.kind === 'error') {
              return done(new ExecutionError(String(value.code), String(value.message)));
            }
            if (
              !exact(value, ['schemaVersion', 'kind', 'requestId', 'output']) ||
              value.schemaVersion !== 1 ||
              value.kind !== 'result' ||
              value.requestId !== requestId
            ) {
              return done(new ExecutionError('BRIDGE_STALE_RESULT', 'Bridge result is stale.'));
            }
            done(undefined, value.output as JsonValue);
          } catch (error) {
            done(error);
          }
        });
      });
    },
  };
}
