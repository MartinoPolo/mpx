import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeCapabilityManifest, type ToolAuthority } from '@mpx/runtime-contracts';
import { materializeClaudeGateway } from '../../src/node/index.js';

const launchKey = 'a'.repeat(64);
const authority = (name: string, routes: string[] = []): ToolAuthority => ({
  schemaVersion: 1,
  name,
  executors: ['host'],
  routes,
  network: { mode: 'deny-all', destinations: [] },
  paidCredits: { allowed: false, maxCredits: 0 },
  input: { maxBytes: 1024 * 1024 },
  output: { maxBytes: 1024 * 1024 },
  timeout: { maxMs: 5000 },
  cache: { mode: 'disabled', maxBytes: 0 },
});
function capability(identity: 'personal' | 'work', routes = ['mcp:fixture']) {
  return createRuntimeCapabilityManifest({
    runtime: 'claude',
    launchKey,
    identity: { name: identity, domain: identity, nativeRuntimeRootDigest: 'b'.repeat(64) },
    binding: {
      projectId: 'app',
      repositoryId: 'repo',
      selection: {
        location: { name: identity, canonicalRoot: process.cwd() },
        packs: [identity === 'personal' ? 'personal' : 'development'],
        source: 'project',
      },
    },
    executor: 'host',
    tools: [authority('mcp', routes), authority('dev_server')],
    routes,
    resources: [],
    mounts: [],
    destinations: [],
    skills: [],
    models: ['sonnet'],
    nesting: { depth: 0, maxDepth: 2 },
  });
}
const binding = {
  launchKey,
  runtime: 'claude' as const,
  identity: { name: 'personal', domain: 'personal' },
  worktreeRoot: process.cwd(),
  assignedPorts: [] as number[],
  executor: 'host' as const,
};
async function rpc(command: string, args: string[], requests: unknown[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
      responses: any[] = [];
    let buffer = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          responses.push(JSON.parse(line));
        }
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(responses) : reject(new Error(`gateway ${code}: ${stderr}`)),
    );
    child.stdin.end(requests.map((value) => JSON.stringify(value)).join('\n') + '\n');
  });
}

describe('Claude production aggregate gateway', () => {
  it.each(['personal', 'work'] as const)(
    'handshakes and invokes only the selected %s MCP route',
    async (identity) => {
      const root = await mkdtemp(path.join(tmpdir(), 'mpx-gateway-')),
        routes = path.join(root, 'routes');
      await mkdir(routes);
      const downstream = path.join(root, 'downstream.mjs');
      await writeFile(
        downstream,
        'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;for(;;){const n=b.indexOf("\\n");if(n<0)break;const line=b.slice(0,n).trim();b=b.slice(n+1);if(!line)continue;const r=JSON.parse(line);if(r.id)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:r.method==="initialize"?{protocolVersion:"2024-11-05",capabilities:{},serverInfo:{name:"fake",version:"1"}}:{identity:' +
          JSON.stringify(identity) +
          ',method:r.method}})+"\\n")}});',
      );
      const route = path.join(routes, 'route.json');
      await writeFile(
        route,
        JSON.stringify({
          mcpServers: {
            fixture: {
              type: 'stdio',
              command: process.execPath,
              args: [downstream],
              secret: 'must-not-leak',
            },
          },
        }),
      );
      // The production route validator has already stripped unsupported fields before this boundary.
      await writeFile(
        route,
        JSON.stringify({
          mcpServers: { fixture: { type: 'stdio', command: process.execPath, args: [downstream] } },
        }),
      );
      const materialized = await materializeClaudeGateway({
        stateRoot: root,
        capability: capability(identity),
        launchBinding: { ...binding, identity: { name: identity, domain: identity } },
        routes: { 'mcp:fixture': route },
      });
      const config = JSON.parse(await readFile(materialized.configPath, 'utf8')),
        server = config.mcpServers.mpx_gateway;
      expect(JSON.stringify(config)).not.toContain(await readFile(route, 'utf8'));
      const responses = await rpc(server.command, server.args, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'mcp',
            arguments: { serverId: 'fixture', method: 'tools/list', params: {} },
          },
        },
      ]);
      expect(responses[1].result.tools.map((tool: any) => tool.name)).toEqual([
        'mcp',
        'dev_server',
      ]);
      expect(JSON.parse(responses[2].result.content[0].text).output).toEqual({
        identity,
        method: 'tools/list',
      });
    },
  );
  it('materializes stable bytes with explicitly ordered routes across equivalent input order', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-gateway-stable-'));
    const routeFiles = Object.fromEntries(
      await Promise.all(
        ['alpha', 'zeta'].map(async (label) => {
          const file = path.join(root, `${label}.json`);
          await writeFile(
            file,
            JSON.stringify({
              mcpServers: {
                [label]: { type: 'stdio', command: process.execPath, args: [label] },
              },
            }),
          );
          return [`mcp:${label}`, file];
        }),
      ),
    );
    const input = {
      stateRoot: root,
      capability: capability('personal', ['mcp:zeta', 'mcp:alpha']),
      launchBinding: binding,
    };
    const first = await materializeClaudeGateway({
      ...input,
      routes: { 'mcp:zeta': routeFiles['mcp:zeta'], 'mcp:alpha': routeFiles['mcp:alpha'] },
    });
    const firstState = await readFile(first.statePath),
      firstConfig = await readFile(first.configPath);
    const second = await materializeClaudeGateway({
      ...input,
      routes: { 'mcp:alpha': routeFiles['mcp:alpha'], 'mcp:zeta': routeFiles['mcp:zeta'] },
    });
    const secondState = await readFile(second.statePath),
      secondConfig = await readFile(second.configPath);

    expect(Object.keys(JSON.parse(secondState.toString()).mcpRoutes)).toEqual(['alpha', 'zeta']);
    expect(secondState).toEqual(firstState);
    expect(secondConfig).toEqual(firstConfig);
  });

  it('denies an unselected route at the aggregate boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-gateway-deny-')),
      route = path.join(root, 'route.json');
    await writeFile(
      route,
      JSON.stringify({
        mcpServers: { fixture: { type: 'stdio', command: process.execPath, args: [] } },
      }),
    );
    const materialized = await materializeClaudeGateway({
        stateRoot: root,
        capability: capability('personal'),
        launchBinding: binding,
        routes: { 'mcp:fixture': route },
      }),
      config = JSON.parse(await readFile(materialized.configPath, 'utf8')),
      server = config.mcpServers.mpx_gateway;
    const responses = await rpc(server.command, server.args, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'mcp',
          arguments: { serverId: 'work-only', method: 'tools/list', params: {} },
        },
      },
    ]);
    expect(responses[0].error.message).toMatch(/MCP_ROUTE_DENIED/);
  });
});
