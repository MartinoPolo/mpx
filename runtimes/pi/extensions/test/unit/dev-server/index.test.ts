import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import { DEV_SERVERS_CHANGED_EVENT } from '../../../dev-server/contract.js';

test('installed Pi loader registers the package tool, command, event, and idempotent shutdown', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'pi-dev-server-test-'));
  try {
    const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
    const packageDirectory = fileURLToPath(new URL('../../../dev-server/', import.meta.url));
    const result = await discoverAndLoadExtensions([packageDirectory], process.cwd(), agentDir);

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0]!;
    assert.deepEqual([...extension.tools.keys()], ['dev_server']);
    assert.equal(extension.commands.has('dev-servers'), true);
    const shutdownHandlers = extension.handlers.get('session_shutdown') ?? [];
    assert.equal(shutdownHandlers.length, 1);

    const tool = extension.tools.get('dev_server')!.definition;
    const response = await tool.execute('call', { action: 'status' }, undefined, undefined, {
      cwd: process.cwd(),
    } as any);
    const firstContent = response.content[0];
    assert.ok(firstContent && firstContent.type === 'text');
    assert.equal(firstContent.text, 'No managed dev servers.');
    await shutdownHandlers[0]!({} as any, {} as any);
    await shutdownHandlers[0]!({} as any, {} as any);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}, 30_000);

test('uses the shared managed dev-server event channel', () => {
  assert.equal(DEV_SERVERS_CHANGED_EVENT, 'dev-servers:changed');
});
