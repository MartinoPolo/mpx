import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClaudeDevServerCapability } from '@mpx/runtime-claude';
import {
  activateRuntimeToolGateway,
  type GatewayExecutor,
  type McpLaunchDescriptor,
} from '@mpx/runtime-tools';
import {
  parseRuntimeCapabilityManifestV1,
  type JsonData,
  type RuntimeCapabilityManifestV1,
} from '@mpx/runtime-contracts';
import type { RuntimeLaunchBinding } from '@mpx/executors';

export interface ClaudeGatewayMaterializationInput {
  readonly stateRoot: string;
  readonly capability: RuntimeCapabilityManifestV1;
  readonly launchBinding: RuntimeLaunchBinding;
  readonly routes: Readonly<Record<string, string>>;
}
export interface ClaudeGatewayMaterialization {
  readonly configPath: string;
  readonly statePath: string;
}
interface GatewayState {
  schemaVersion: 1;
  capability: RuntimeCapabilityManifestV1;
  launchBinding: RuntimeLaunchBinding;
  mcpRoutes: Record<string, McpLaunchDescriptor>;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
async function atomic(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function routeDescriptor(file: string, label: string): Promise<McpLaunchDescriptor> {
  const stat = await lstat(file),
    resolved = await realpath(file),
    root = await realpath(path.dirname(file));
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !within(root, resolved) ||
    stat.size > 1024 * 1024
  ) {
    throw new Error('MCP_ROUTE_INVALID');
  }
  const parsed = JSON.parse(await readFile(file, 'utf8')) as {
    mcpServers?: Record<string, unknown>;
  };
  const server = parsed.mcpServers?.[label] as
    { type?: unknown; command?: unknown; args?: unknown } | undefined;
  if (
    !server ||
    server.type !== 'stdio' ||
    typeof server.command !== 'string' ||
    (!path.win32.isAbsolute(server.command) && !path.posix.isAbsolute(server.command)) ||
    !Array.isArray(server.args) ||
    server.args.some((value) => typeof value !== 'string')
  ) {
    throw new Error('MCP_ROUTE_INVALID');
  }
  return Object.freeze({
    kind: 'process',
    executable: server.command,
    argv: Object.freeze([...server.args] as string[]),
  });
}
/** Writes one private aggregate config. Raw selected route descriptors remain only in the private state file. */
export async function materializeClaudeGateway(
  input: ClaudeGatewayMaterializationInput,
): Promise<ClaudeGatewayMaterialization> {
  const capability = parseRuntimeCapabilityManifestV1(input.capability);
  if (capability.runtime !== 'claude' || capability.launchKey !== input.launchBinding.launchKey) {
    throw new Error('GATEWAY_BINDING_INVALID');
  }
  const root = path.join(input.stateRoot, 'claude-gateways', capability.launchKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const mcpRoutes: Record<string, McpLaunchDescriptor> = {};
  for (const label of capability.routes
    .filter((route) => route.startsWith('mcp:'))
    .map((route) => route.slice(4))
    .sort()) {
    const selected = input.routes[`mcp:${label}`];
    if (!selected) {
      throw new Error('MCP_ROUTE_UNAVAILABLE');
    }
    mcpRoutes[label] = await routeDescriptor(selected, label);
  }
  const statePath = path.join(root, 'state.json'),
    configPath = path.join(root, 'mcp.json');
  await atomic(statePath, {
    schemaVersion: 1,
    capability,
    launchBinding: input.launchBinding,
    mcpRoutes,
  } satisfies GatewayState);
  const adjacent = fileURLToPath(new URL('./claude-gateway.js', import.meta.url));
  const gatewayEntry = existsSync(adjacent)
    ? adjacent
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/claude-gateway.js');
  await atomic(configPath, {
    mcpServers: {
      mpx_gateway: {
        type: 'stdio',
        command: process.execPath,
        args: [gatewayEntry, '--state', statePath],
      },
    },
  });
  return Object.freeze({ configPath, statePath });
}

function rpcProcess(
  descriptor: Extract<McpLaunchDescriptor, { kind: 'process' }>,
  method: string,
  params: JsonData,
  signal?: AbortSignal,
): Promise<{ output: JsonData }> {
  return new Promise((resolve, reject) => {
    const child = spawn(descriptor.executable, [...descriptor.argv], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: {},
      }),
      callId = 2;
    let text = '',
      errors = '',
      settled = false,
      initialized = false;
    const stop = () => {
      if (!child.killed) {
        child.kill();
      }
    };
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      for (;;) {
        const newline = text.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = text.slice(0, newline).trim();
        text = text.slice(newline + 1);
        if (!line) {
          continue;
        }
        try {
          const value = JSON.parse(line) as { id?: number; result?: JsonData; error?: unknown };
          if (value.id === 1 && !initialized) {
            if (value.error) {
              settled = true;
              stop();
              reject(new Error('MCP_ROUTE_FAILED'));
              break;
            }
            initialized = true;
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: callId, method, params })}\n`,
            );
          } else if (value.id === callId) {
            settled = true;
            stop();
            if (value.error) {
              reject(new Error('MCP_ROUTE_FAILED'));
            } else {
              resolve({ output: value.result ?? null });
            }
          }
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-4096);
    });
    child.once('error', reject);
    child.once('exit', () => {
      if (!settled) {
        reject(new Error(errors ? 'MCP_ROUTE_FAILED' : 'MCP_ROUTE_CLOSED'));
      }
    });
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mpx_gateway', version: '0.0.0' },
      },
    };
    child.stdin.write(`${JSON.stringify(initialize)}\n`);
  });
}
function hostGatewayExecutor(): GatewayExecutor {
  return {
    name: 'host',
    resolveDns: async () => [],
    requestNetwork: async () => {
      throw new Error('NETWORK_DENIED');
    },
    executeProcess: async (request) =>
      rpcProcess(
        {
          kind: 'process',
          executable: request.executable,
          argv: request.argv,
          environment: request.environment,
        },
        request.method,
        request.params,
        request.signal,
      ),
  };
}
const schemas: Record<string, unknown> = {
  mcp: {
    type: 'object',
    properties: { serverId: { type: 'string' }, method: { type: 'string' }, params: {} },
    required: ['serverId', 'method', 'params'],
  },
  dev_server: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
};
async function serve(statePath: string): Promise<void> {
  const stat = await lstat(statePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('GATEWAY_STATE_INVALID');
  }
  const state = JSON.parse(await readFile(statePath, 'utf8')) as GatewayState,
    capability = parseRuntimeCapabilityManifestV1(state.capability);
  if (state.schemaVersion !== 1 || capability.launchKey !== state.launchBinding.launchKey) {
    throw new Error('GATEWAY_STATE_INVALID');
  }
  if (state.launchBinding.executor !== 'host') {
    throw new Error('DOCKER_ADAPTER_REQUIRED');
  }
  const dev = createClaudeDevServerCapability({
    launchKey: capability.launchKey,
    executor: 'host',
    worktreeRoot: state.launchBinding.worktreeRoot,
    assignedPorts: state.launchBinding.assignedPorts,
  });
  const gateway = activateRuntimeToolGateway({
    capability,
    executor: hostGatewayExecutor(),
    mcpRoutes: state.mcpRoutes,
    providers: [],
  });
  const tools = new Map<string, (value: any) => Promise<unknown>>([
      ['mcp', (value) => gateway.mcp(value)],
      ['dev_server', (value) => dev.tool.execute(value)],
    ]),
    available = (name: string) =>
      capability.tools.some((tool) => tool.name === name) &&
      (name !== 'mcp' || Object.keys(state.mcpRoutes).length > 0);
  let buffer = '',
    chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        chain = chain.then(async () => {
          let request: any;
          try {
            request = JSON.parse(line);
            let result: unknown;
            if (request.method === 'initialize') {
              result = {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'mpx_gateway', version: '0.0.0' },
              };
            } else if (request.method === 'tools/list') {
              result = {
                tools: [...tools.keys()].filter(available).map((name) => ({
                  name,
                  description: `Launch-bound ${name}`,
                  inputSchema: schemas[name],
                })),
              };
            } else if (request.method === 'tools/call') {
              const execute = tools.get(request.params?.name);
              if (!execute || !available(request.params.name)) {
                throw new Error('ROUTE_DENIED');
              }
              const value = await execute(request.params.arguments ?? {});
              result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
            } else if (request.id === undefined) {
              return;
            } else {
              throw new Error('METHOD_NOT_FOUND');
            }
            if (request.id !== undefined) {
              process.stdout.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`,
              );
            }
          } catch (error) {
            if (request?.id !== undefined) {
              process.stdout.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'GATEWAY_ERROR' } })}\n`,
              );
            }
          }
        });
      }
    }
  });
  await new Promise<void>((resolve) => process.stdin.once('end', resolve));
  await chain;
  await dev.shutdown();
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const index = process.argv.indexOf('--state'),
    state = index >= 0 ? process.argv[index + 1] : undefined;
  if (!state || (!path.win32.isAbsolute(state) && !path.posix.isAbsolute(state))) {
    process.exitCode = 2;
  } else {
    serve(state).catch(() => {
      process.exitCode = 2;
    });
  }
}
