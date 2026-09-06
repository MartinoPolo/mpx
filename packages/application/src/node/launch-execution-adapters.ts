import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import {
  ExecutionError,
  locateTrustedExecutable,
  type ExecutorAdapter,
  type FileInspection,
  type ProcessRequest,
  type ProcessResult,
} from '@mpx/executors';
import type { LaunchDescriptor } from '@mpx/launch';
import {
  parseRuntimeStatusEnvelopeV1,
  parseStatusSnapshotV1,
  readStatusSnapshotV1,
  type RuntimeStatusEnvelopeV1,
  type StatusSnapshotV1,
} from '@mpx/status';
import type {
  LaunchStatusSnapshotBinding,
  LaunchStatusSnapshotMaterializer,
  RuntimeStatusEnvelopeAuthorityV1,
  RuntimeStatusEnvelopeMaterializer,
} from '../launch-execution-service.js';

export type LaunchExecutableResolver = (input: {
  runtime: 'claude' | 'pi';
  candidate: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}) => Promise<{ executable: string; argvPrefix: readonly string[] }>;

const SHA256 = /^[a-f0-9]{64}$/u;

/** Atomic private live-status persistence. Authority is launch/root digest evidence, never renderer-visible session authority. */
export class NodeRuntimeStatusEnvelopeMaterializer implements RuntimeStatusEnvelopeMaterializer {
  constructor(readonly stateRoot: string) {}
  async materialize(
    input: { envelope: RuntimeStatusEnvelopeV1; authority: RuntimeStatusEnvelopeAuthorityV1 },
    signal?: AbortSignal,
  ): Promise<string> {
    const envelope = parseRuntimeStatusEnvelopeV1(input.envelope);
    if (
      !SHA256.test(input.authority.descriptorDigest) ||
      !SHA256.test(input.authority.runtimeRootDigest)
    ) {
      throw new MpxError({
        code: 'RUNTIME_STATUS_BINDING_INVALID',
        message: 'Live status authority is malformed.',
      });
    }
    const authority = Object.freeze({
      schemaVersion: 1,
      binding: envelope.binding,
      harness: envelope.harness.kind,
      descriptorDigest: input.authority.descriptorDigest,
      runtimeRootDigest: input.authority.runtimeRootDigest,
    });
    try {
      signal?.throwIfAborted();
      const root = path.join(
        this.stateRoot,
        'runtime-status',
        sha256Canonical({
          binding: envelope.binding,
          harness: envelope.harness.kind,
        } as unknown as JsonValue),
      );
      await mkdir(root, { recursive: true });
      const [stateStat, rootStat] = await Promise.all([lstat(this.stateRoot), lstat(root)]);
      if (
        stateStat.isSymbolicLink() ||
        !stateStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        !rootStat.isDirectory() ||
        !pathWithin(await realpath(this.stateRoot), await realpath(root))
      ) {
        throw new Error('unsafe root');
      }
      const target = path.join(root, 'current.json'),
        bindingFile = path.join(root, 'authority.json'),
        authorityText = JSON.stringify(authority);
      const priorAuthority = await readFile(bindingFile, 'utf8').catch((error) =>
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error),
      );
      if (priorAuthority !== undefined && priorAuthority !== authorityText) {
        throw new MpxError({
          code: 'RUNTIME_STATUS_BINDING_INVALID',
          message: 'Live status launch, runtime, repository, or root evidence changed.',
        });
      }
      if (priorAuthority === undefined) {
        await writeFile(bindingFile, authorityText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      const prior = await readFile(target, 'utf8').catch((error) =>
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error),
      );
      if (prior !== undefined) {
        try {
          const parsed = parseRuntimeStatusEnvelopeV1(JSON.parse(prior));
          if (
            JSON.stringify(parsed.binding) !== JSON.stringify(envelope.binding) ||
            parsed.harness.kind !== envelope.harness.kind
          ) {
            throw new Error('foreign');
          }
        } catch {
          await rename(target, path.join(root, `.quarantine-${randomUUID()}.json`));
        }
      }
      signal?.throwIfAborted();
      const temporary = path.join(root, `.current-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(envelope), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        signal?.throwIfAborted();
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return target;
    } catch (error) {
      if (error instanceof MpxError || (error as { code?: unknown }).code === 'ABORT_ERR') {
        throw error;
      }
      throw new MpxError({
        code: 'RUNTIME_STATUS_PATH_INVALID',
        message: 'The private live status location is unsafe or unavailable.',
      });
    }
  }
}
function statusError(
  code: 'STATUS_SNAPSHOT_PATH_INVALID' | 'STATUS_SNAPSHOT_BINDING_INVALID',
  message: string,
): MpxError {
  return new MpxError({ code, message, retryable: false });
}
function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
function statusBinding(
  descriptor: LaunchDescriptor,
  repositoryId: string,
  snapshot: StatusSnapshotV1,
): LaunchStatusSnapshotBinding {
  return Object.freeze({
    schemaVersion: 1,
    launchKey: descriptor.launchKey,
    projectId: snapshot.project.id,
    repositoryId,
    worktreeId: snapshot.worktree.id,
    worktreePath: snapshot.worktree.path,
  });
}

export class NodeLaunchStatusSnapshotMaterializer implements LaunchStatusSnapshotMaterializer {
  constructor(readonly stateRoot: string) {}
  async materialize(
    input: { binding: LaunchStatusSnapshotBinding; snapshot: StatusSnapshotV1 },
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      signal?.throwIfAborted();
      if (!path.isAbsolute(this.stateRoot)) {
        throw new Error('state root');
      }
      const rootStat = await lstat(this.stateRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error('state root shape');
      }
      const canonicalStateRoot = await realpath(this.stateRoot);
      const statusRoot = path.join(this.stateRoot, 'status');
      await mkdir(statusRoot, { recursive: true });
      const statusStat = await lstat(statusRoot),
        canonicalStatusRoot = await realpath(statusRoot);
      if (
        statusStat.isSymbolicLink() ||
        !statusStat.isDirectory() ||
        !pathWithin(canonicalStateRoot, canonicalStatusRoot)
      ) {
        throw new Error('status root shape');
      }
      const segments = [
        sha256Canonical(input.binding.projectId as unknown as JsonValue),
        sha256Canonical(input.binding.repositoryId as unknown as JsonValue),
        sha256Canonical(
          JSON.stringify([
            input.binding.worktreeId,
            input.binding.worktreePath,
          ]) as unknown as JsonValue,
        ),
        input.binding.launchKey,
      ];
      let directory = statusRoot;
      for (const segment of segments) {
        directory = path.join(directory, segment);
        await mkdir(directory, { recursive: true });
        const stat = await lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error('status directory shape');
        }
      }
      if (!pathWithin(canonicalStatusRoot, await realpath(directory))) {
        throw new Error('status directory escape');
      }
      const snapshotPath = path.join(directory, 'current.json');
      for (const file of [snapshotPath, `${snapshotPath}.binding.json`]) {
        try {
          if ((await lstat(file)).isSymbolicLink()) {
            throw new Error('status file link');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }
      const bindingPath = `${snapshotPath}.binding.json`;
      const bindingText = JSON.stringify(input.binding);
      signal?.throwIfAborted();
      const bindingTemporary = path.join(directory, `.binding-${randomUUID()}.tmp`);
      try {
        await writeFile(bindingTemporary, bindingText, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        try {
          await link(bindingTemporary, bindingPath);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            (await readFile(bindingPath, 'utf8')) !== bindingText
          ) {
            throw error;
          }
        }
      } finally {
        await rm(bindingTemporary, { force: true });
      }
      const temporaryPath = path.join(directory, `.current-${randomUUID()}.tmp`);
      try {
        signal?.throwIfAborted();
        await writeFile(temporaryPath, JSON.stringify(input.snapshot), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        signal?.throwIfAborted();
        await rename(temporaryPath, snapshotPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      return snapshotPath;
    } catch (error) {
      if (error instanceof MpxError) {
        throw error;
      }
      throw statusError(
        'STATUS_SNAPSHOT_PATH_INVALID',
        'The MPX private status snapshot location is unsafe.',
      );
    }
  }
}

export async function resolveLaunchStatusSnapshotPath(input: {
  stateRoot: string;
  descriptor: LaunchDescriptor;
  repositoryId: string;
  snapshot: StatusSnapshotV1;
  materializer?: LaunchStatusSnapshotMaterializer;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const expected = statusBinding(
    input.descriptor,
    input.repositoryId,
    parseStatusSnapshotV1(input.snapshot),
  );
  const statusRoot = path.join(input.stateRoot, 'status');
  let candidate: string | undefined;
  try {
    candidate = await (
      input.materializer ?? new NodeLaunchStatusSnapshotMaterializer(input.stateRoot)
    ).materialize({ binding: expected, snapshot: input.snapshot }, input.signal);
  } catch (error) {
    if (error instanceof MpxError) {
      throw error;
    }
    throw statusError(
      'STATUS_SNAPSHOT_BINDING_INVALID',
      'The private status snapshot could not be resolved.',
    );
  }
  input.signal?.throwIfAborted();
  if (candidate === undefined) {
    return undefined;
  }
  try {
    if (
      !path.isAbsolute(input.stateRoot) ||
      !path.isAbsolute(candidate) ||
      !pathWithin(statusRoot, candidate)
    ) {
      throw statusError(
        'STATUS_SNAPSHOT_PATH_INVALID',
        'The private status snapshot path is outside MPX local state.',
      );
    }
    const [rootStat, fileStat, bindingStat] = await Promise.all([
      lstat(statusRoot),
      lstat(candidate),
      lstat(`${candidate}.binding.json`),
    ]);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      fileStat.isSymbolicLink() ||
      !fileStat.isFile() ||
      bindingStat.isSymbolicLink() ||
      !bindingStat.isFile() ||
      bindingStat.size > 16_384
    ) {
      throw statusError(
        'STATUS_SNAPSHOT_PATH_INVALID',
        'The private status snapshot path is unsafe.',
      );
    }
    const [canonicalRoot, canonicalFile, binding, current] = await Promise.all([
      realpath(statusRoot),
      realpath(candidate),
      readFile(`${candidate}.binding.json`, 'utf8').then((text) => JSON.parse(text) as unknown),
      readStatusSnapshotV1(candidate),
    ]);
    if (!pathWithin(canonicalRoot, canonicalFile)) {
      throw statusError(
        'STATUS_SNAPSHOT_PATH_INVALID',
        'The private status snapshot path escapes MPX local state.',
      );
    }
    if (
      JSON.stringify(binding) !== JSON.stringify(expected) ||
      current.project.id !== expected.projectId ||
      current.worktree.id !== expected.worktreeId ||
      current.worktree.path !== expected.worktreePath
    ) {
      throw statusError(
        'STATUS_SNAPSHOT_BINDING_INVALID',
        'The private status snapshot is not bound to this launch.',
      );
    }
    return canonicalFile;
  } catch (error) {
    if (error instanceof MpxError) {
      throw error;
    }
    throw statusError(
      'STATUS_SNAPSHOT_BINDING_INVALID',
      'The private status snapshot is missing, invalid, or unbound.',
    );
  }
}
export type TrustedRuntimeExecutable = { executable: string; argvPrefix: readonly string[] };

const unavailableResult = (): never => {
  throw new ExecutionError(
    'EXECUTOR_GATE_UNVERIFIED',
    'Docker execution is gated until runtime containment evidence is available.',
    { executor: 'docker' },
  );
};
export const nodeDockerGate: ExecutorAdapter = {
  name: 'docker',
  verify: async () => ({
    status: 'unverified',
    verifier: 'whole-agent-sandbox-pending',
    evidenceDigest: sha256Canonical({ executor: 'docker', integration: 'pending' }),
  }),
  execute: async () => unavailableResult(),
};

function inheritedProcess(request: ProcessRequest): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    request.signal?.throwIfAborted();
    const child = spawn(request.executable, [...request.argv], {
      cwd: request.cwd,
      env: { ...request.environment },
      shell: false,
      stdio: 'inherit',
      windowsHide: false,
    });
    const cancel = () => {
      if (child.pid && process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
      } else {
        child.kill('SIGTERM');
      }
    };
    request.signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      request.signal?.removeEventListener('abort', cancel);
      resolve({ exitCode: code ?? (signal ? 1 : 0), stdout: '', stderr: '', truncated: false });
    });
  });
}
export const nodeHostExecutor: ExecutorAdapter = {
  name: 'host',
  verify: async () => ({
    status: 'verified',
    verifier: 'direct-host',
    evidenceDigest: sha256Canonical({ executor: 'host', invocation: 'direct-inherited-stdio' }),
  }),
  execute: inheritedProcess,
};
const MAX_JS_WRAPPER_BYTES = 131_072;
function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new MpxError({
      code: 'RUNTIME_PROJECTION_REQUIRED',
      message: `Trusted runtime input ${name} is required.`,
      remediation: 'Configure the trusted runtime executable, then relaunch.',
    });
  }
  return value;
}
async function absoluteRoots(environment: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const roots = new Set<string>();
  const include = async (value: string | undefined): Promise<void> => {
    if (!value) {
      return;
    }
    const trimmed = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    if (!path.win32.isAbsolute(trimmed) && !path.posix.isAbsolute(trimmed)) {
      return;
    }
    roots.add(trimmed);
    const resolved = await realpath(trimmed).catch(() => undefined);
    if (resolved) {
      roots.add(resolved);
    }
  };
  const pathValues = new Set([environment.PATH, environment.Path]);
  for (const value of pathValues) {
    for (const directory of (value ?? '').split(path.delimiter)) {
      await include(directory);
    }
  }
  await include(environment.MPX_APPS);
  await include(path.dirname(process.execPath));
  return [...roots];
}
async function inspectExecutable(file: string): Promise<FileInspection> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { file: false, realpath: file };
  }
  const resolved = await realpath(file);
  const extension = path.extname(resolved);
  if (/\.(?:mjs|cjs|js)$/iu.test(resolved)) {
    if (stat.size > MAX_JS_WRAPPER_BYTES) {
      throw new Error('wrapper too large');
    }
    return { file: true, realpath: resolved, content: (await readFile(file)).toString('utf8') };
  }
  if (extension === '') {
    const handle = await open(file, 'r');
    try {
      const prefix = Buffer.alloc(Math.min(stat.size, 4097));
      await handle.read(prefix, 0, prefix.length, 0);
      if (prefix[0] === 0x23 && prefix[1] === 0x21) {
        return {
          file: true,
          realpath: resolved,
          content: stat.size <= 4096 ? prefix.toString('utf8') : '#!oversized',
        };
      }
    } finally {
      await handle.close();
    }
  }
  return { file: true, realpath: resolved };
}
export async function resolveTrustedRuntimeExecutable(input: {
  runtime: 'claude' | 'pi';
  cwd: string;
  environment: NodeJS.ProcessEnv;
  resolver?: LaunchExecutableResolver;
}): Promise<TrustedRuntimeExecutable> {
  const variable = input.runtime === 'claude' ? 'MPX_CLAUDE_EXECUTABLE' : 'MPX_PI_EXECUTABLE';
  const candidate = requiredEnvironment(input.environment, variable);
  if (input.resolver) {
    return input.resolver({
      runtime: input.runtime,
      candidate,
      cwd: input.cwd,
      environment: input.environment,
    });
  }
  return locateTrustedExecutable({
    candidates: [candidate],
    projectRoot: input.cwd,
    trustedRoots: await absoluteRoots(input.environment),
    nodeExecutable: process.execPath,
    platform: process.platform,
    ...(input.runtime === 'pi' ? { knownWrapper: 'pi-fnm' as const } : {}),
    inspect: inspectExecutable,
  });
}
