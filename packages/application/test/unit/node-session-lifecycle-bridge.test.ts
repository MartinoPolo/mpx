import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionLifecycleEvent, type RuntimeContext } from '@mpx/runtime-contracts';
import type { LaunchDescriptor } from '@mpx/launch';
import { SessionStore, type ProcessInspection } from '@mpx/sessions';
import { describe, expect, it } from 'vitest';
import { ProductionSessionLifecycleBridge } from '../../src/node/session-lifecycle-bridge.js';

const hash = (character: string) => character.repeat(64);
async function observeStartWithInspection(
  inspection: ProcessInspection,
): Promise<Awaited<ReturnType<ProductionSessionLifecycleBridge['observe']>>> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-lifecycle-observation-'));
  try {
    const store = new SessionStore(path.join(root, 'state'));
    const input = { ...launchFixture(root), nativeRuntimeRoot: path.join(root, 'native-pi') };
    const bridge = new ProductionSessionLifecycleBridge({
      store,
      processInspector: { inspect: async () => inspection },
    });
    const prepared = await bridge.prepare(input);
    const event = createSessionLifecycleEvent({
      eventId: 'event-1',
      bindingId: prepared.binding.bindingId,
      type: 'start',
      sequence: 1,
      timestamp: new Date().toISOString(),
      nativeSessionId: 'native-1',
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/native-1.jsonl' },
      cwd: input.cwd,
      title: 'Session title',
      model: 'safe-model',
      effort: null,
      pid: 4242,
      startFingerprint: 'process-start-1',
    });
    await writeFile(
      path.join(prepared.eventDirectory, '000000000001-event-1.json'),
      `${JSON.stringify(event)}\n`,
    );
    return await bridge.observe(prepared.binding.bindingId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function launchFixture(root: string): {
  descriptor: LaunchDescriptor;
  runtimeContext: RuntimeContext;
  cwd: string;
} {
  const cwd = path.join(root, 'repository');
  const descriptor = {
    runtime: 'pi',
    identity: { domain: 'personal', name: 'personal' },
    launchKey: hash('a'),
    binding: { projectId: 'sample/project', repositoryId: 'sample/repository' },
    mode: 'project',
    selection: {
      location: { name: 'personal', canonicalRoot: cwd },
      packs: ['personal'],
      source: 'project',
    },
    executor: { name: 'host' },
    workspace: 'direct',
    networkPolicy: { name: 'minimal' },
  } as unknown as LaunchDescriptor;
  const runtimeContext = {
    launchDescriptor: { digest: hash('b') },
    runtimeArtifact: { artifactKey: hash('c') },
    manifestKey: hash('d'),
  } as RuntimeContext;
  return { descriptor, runtimeContext, cwd };
}

describe('ProductionSessionLifecycleBridge', () => {
  it('keeps an exact verified lifecycle process active while persisting and consuming its event', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-lifecycle-bridge-'));
    try {
      const store = new SessionStore(path.join(root, 'state'));
      const input = { ...launchFixture(root), nativeRuntimeRoot: path.join(root, 'native-pi') };
      const bridge = new ProductionSessionLifecycleBridge({
        store,
        processInspector: {
          inspect: async (pid) => ({
            status: 'present',
            pid,
            startFingerprint: 'unavailable:test-process-start',
          }),
        },
      });

      const prepared = await bridge.prepare(input);
      const nativeBindings = await store.listNativeBindings();
      expect(nativeBindings).toHaveLength(1);
      expect(nativeBindings[0]).toMatchObject({
        runtime: 'pi',
        identity: input.descriptor.identity,
      });
      expect(await store.readLifecycleBinding(prepared.binding.bindingId)).toMatchObject({
        binding: prepared.binding,
        nativeBindingRef: nativeBindings[0]!.ref,
        launch: {
          launchKey: input.descriptor.launchKey,
          descriptorDigest: input.runtimeContext.launchDescriptor.digest,
        },
      });
      expect(await lstat(prepared.eventDirectory)).toMatchObject({});
      expect((await lstat(prepared.eventDirectory)).isDirectory()).toBe(true);

      await bridge.prepare(input);
      expect(await store.listNativeBindings()).toHaveLength(1);

      const event = createSessionLifecycleEvent({
        eventId: 'event-1',
        bindingId: prepared.binding.bindingId,
        type: 'start',
        sequence: 1,
        timestamp: new Date().toISOString(),
        nativeSessionId: 'native-1',
        nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/native-1.jsonl' },
        cwd: input.cwd,
        title: 'Session title',
        model: 'safe-model',
        effort: null,
        pid: process.pid,
        startFingerprint: 'unavailable:test-process-start',
      });
      await writeFile(
        path.join(prepared.eventDirectory, '000000000001-event-1.json'),
        `${JSON.stringify(event)}\n`,
      );
      const observation = await bridge.observe(prepared.binding.bindingId);
      expect(observation).toMatchObject({
        runtime: 'pi',
        runtimeQualifiedId: 'pi:native-1',
        title: 'Session title',
        lifecycleState: 'active',
        source: 'sessions:lifecycle',
      });
      await expect(bridge.consume(prepared.binding.bindingId)).resolves.toBeUndefined();
      const partitions = await store.partitions();
      expect(partitions).toHaveLength(1);
      expect(partitions[0]!.records[0]).toMatchObject({
        runtimeQualifiedId: 'pi:native-1',
        nativeBindingRef: nativeBindings[0]!.ref,
        lifecycle: { bindingId: prepared.binding.bindingId, sequence: 1 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports shutdown when the bound lifecycle process is absent', async () => {
    const observation = await observeStartWithInspection({ status: 'absent' });

    expect(observation?.lifecycleState).toBe('shutdown');
  });

  it('reports unknown when the bound lifecycle process cannot be verified', async () => {
    const observation = await observeStartWithInspection({ status: 'unknown' });

    expect(observation?.lifecycleState).toBe('unknown');
  });
});
