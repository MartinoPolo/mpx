import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionLifecycleEventV1, type RuntimeContextV1 } from '@mpx/runtime-contracts';
import type { LaunchDescriptor } from '@mpx/launch';
import { SessionStore } from '@mpx/sessions';
import { describe, expect, it } from 'vitest';
import { ProductionSessionLifecycleBridge } from '../../src/session-lifecycle-bridge.js';

const hash = (character: string) => character.repeat(64);
function launchFixture(root: string): {
  descriptor: LaunchDescriptor;
  runtimeContext: RuntimeContextV1;
  cwd: string;
} {
  const cwd = path.join(root, 'repository');
  const descriptor = {
    runtime: 'pi',
    identity: { domain: 'personal', name: 'personal' },
    launchKey: hash('a'),
    binding: { projectId: 'sample/project', repositoryId: 'sample/repository' },
    mode: 'project',
    skillPolicy: 'clean',
    contentScope: { name: 'personal' },
    executor: { name: 'host' },
    workspace: 'direct',
    networkPolicy: { name: 'minimal' },
    grants: [],
  } as unknown as LaunchDescriptor;
  const runtimeContext = {
    launchDescriptor: { digest: hash('b') },
    runtimeArtifact: { artifactKey: hash('c') },
    manifestKey: hash('d'),
  } as RuntimeContextV1;
  return { descriptor, runtimeContext, cwd };
}

describe('ProductionSessionLifecycleBridge', () => {
  it('persists launch bindings, preserves one-time account attachment, and durably consumes an event', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-lifecycle-bridge-'));
    try {
      const store = new SessionStore(path.join(root, 'state'));
      const input = { ...launchFixture(root), nativeRuntimeRoot: path.join(root, 'native-pi') };
      let attestation: string | null = 'attestation-a';
      const bridge = new ProductionSessionLifecycleBridge(store, async () => attestation);

      const prepared = await bridge.prepare(input);
      const nativeBindings = await store.listNativeBindings();
      expect(nativeBindings).toHaveLength(1);
      expect(nativeBindings[0]).toMatchObject({
        runtime: 'pi',
        identity: input.descriptor.identity,
        accountBindingRef: 'attestation-a',
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

      attestation = null;
      await bridge.prepare(input);
      expect((await store.listNativeBindings())[0]!.accountBindingRef).toBe('attestation-a');

      const event = createSessionLifecycleEventV1({
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

      attestation = 'attestation-b';
      await expect(bridge.prepare(input)).rejects.toMatchObject({
        code: 'SESSION_ACCOUNT_BINDING_MISMATCH',
      });
      expect((await store.listNativeBindings())[0]!.accountBindingRef).toBe('attestation-a');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
