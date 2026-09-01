import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeCapabilityManifestV1 } from '@mpx/runtime-contracts';

const launchKey = 'c'.repeat(64);

async function rpc(command: string, args: string[], requests: unknown[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const responses: any[] = [];
    let buffer = '';
    let stderr = '';
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
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  });
}

describe('bundled Claude gateway', () => {
  it('emits and configures an adjacent direct executable that handshakes and denies unselected routes', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
    const cliBundle = path.join(repositoryRoot, 'bin', 'mpx.mjs');
    const gatewayBundle = path.join(repositoryRoot, 'bin', 'claude-gateway.js');
    await expect(access(gatewayBundle)).resolves.toBeUndefined();
    expect(await readFile(cliBundle, 'utf8')).toContain('claude-gateway.js');

    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-bundled-gateway-'));
    const route = path.join(stateRoot, 'route.json');
    await writeFile(
      route,
      JSON.stringify({
        mcpServers: { fixture: { type: 'stdio', command: process.execPath, args: [] } },
      }),
    );
    const capability = createRuntimeCapabilityManifestV1({
      runtime: 'claude',
      launchKey,
      identity: { name: 'personal', domain: 'personal', nativeRuntimeRootDigest: 'd'.repeat(64) },
      binding: { projectId: 'app', repositoryId: 'repo', contentScope: 'personal' },
      executor: 'host',
      tools: [
        {
          schemaVersion: 1,
          name: 'mcp',
          executors: ['host'],
          routes: ['mcp:fixture'],
          network: { mode: 'deny-all', destinations: [] },
          paidCredits: { allowed: false, maxCredits: 0 },
          input: { maxBytes: 1024 },
          output: { maxBytes: 1024 },
          timeout: { maxMs: 5000 },
          cache: { mode: 'disabled', maxBytes: 0 },
        },
      ],
      routes: ['mcp:fixture'],
      resources: [],
      mounts: [],
      destinations: [],
      skills: [],
      models: ['sonnet'],
      nesting: { depth: 0, maxDepth: 2 },
    });
    const { materializeClaudeGateway } = await import(gatewayBundle);
    const materialized = await materializeClaudeGateway({
      stateRoot,
      capability,
      launchBinding: {
        launchKey,
        runtime: 'claude',
        identity: { name: 'personal', domain: 'personal' },
        worktreeRoot: process.cwd(),
        assignedPorts: [],
        executor: 'host',
      },
      routes: { 'mcp:fixture': route },
    });
    const config = JSON.parse(await readFile(materialized.configPath, 'utf8')),
      configured = config.mcpServers.mpx_gateway;
    expect(configured.command).toBe(process.execPath);
    expect(configured.args).toEqual([gatewayBundle, '--state', materialized.statePath]);

    const responses = await rpc(configured.command, configured.args, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'mcp',
          arguments: { serverId: 'unselected', method: 'tools/list', params: {} },
        },
      },
    ]);
    expect(responses[0].result.serverInfo.name).toBe('mpx_gateway');
    expect(responses[1].error.message).toMatch(/MCP_ROUTE_DENIED/);
  });
});
