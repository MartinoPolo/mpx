import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import { DEV_SERVERS_CHANGED_EVENT } from './contract.js';

class FakeEventBus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(channel);
    };
  }

  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

test('footer removes its managed dev-server listener during session shutdown', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'pi-footer-lifecycle-test-'));
  try {
    const { discoverAndLoadExtensions } = await import('@earendil-works/pi-coding-agent');
    const eventBus = new FakeEventBus();
    const footerPath = fileURLToPath(new URL('../footer.ts', import.meta.url));
    const result = await discoverAndLoadExtensions([footerPath], process.cwd(), agentDir, eventBus);

    assert.deepEqual(result.errors, []);
    const footer = result.extensions.find(
      (extension: any) => path.resolve(extension.path) === path.resolve(footerPath),
    );
    assert.ok(footer);
    assert.equal(eventBus.handlers.get(DEV_SERVERS_CHANGED_EVENT)?.size, 1);
    const shutdownHandlers = footer.handlers.get('session_shutdown') ?? [];
    assert.equal(shutdownHandlers.length, 1);

    await shutdownHandlers[0]!({} as any, {} as any);
    assert.equal(eventBus.handlers.has(DEV_SERVERS_CHANGED_EVENT), false);

    result.runtime.invalidate('footer lifecycle test teardown');
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
