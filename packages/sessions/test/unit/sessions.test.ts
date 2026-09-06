import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createSessionLifecycleBindingV1,
  createSessionLifecycleEventV1,
} from '@mpx/runtime-contracts';
import {
  ClaudeActiveScanner,
  LifecycleEventDirectoryConsumer,
  PiV2ActiveRegistryScanner,
  SessionError,
  SessionService,
  SessionStore,
  deriveNativeBindingRef,
  parseSessionRecordV1,
  planResume,
  type LaunchSnapshotV1,
  type NativeBindingRecordV1,
  type SessionLifecycleBindingRecordV1,
  type SessionRecordV1,
} from '../../src/index.js';

const instant = '2025-01-02T03:04:05.000Z',
  later = '2025-02-02T03:04:05.000Z',
  expires = '2099-01-01T00:00:00.000Z',
  digest = 'a'.repeat(64);
const identity = { domain: 'corp/a', name: 'dev%2Fone' };
const launch: LaunchSnapshotV1 = {
  launchKey: 'key',
  descriptorDigest: digest,
  mode: 'interactive',
  skillPolicy: 'standard',
  contentScope: 'repo',
  executor: { kind: 'host' },
  workspace: 'workspace',
  networkPolicy: 'restricted',
  grants: [{ access: 'read', resource: 'repo' }],
  artifactKey: 'artifact',
  manifestKey: 'manifest',
};
const temporaryRoots: string[] = [];
async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-sessions-'));
  temporaryRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function nativeBinding(overrides: Partial<NativeBindingRecordV1> = {}): NativeBindingRecordV1 {
  return {
    schemaVersion: 1,
    ref: 'native:opaque',
    identity,
    runtime: 'claude',
    recordedRootDigest: digest,
    accountBindingRef: null,
    createdAt: instant,
    updatedAt: instant,
    ...overrides,
  };
}
function lifecycleBindingRecord(bindingId: string): SessionLifecycleBindingRecordV1 {
  return {
    schemaVersion: 1,
    binding: createSessionLifecycleBindingV1({
      bindingId,
      bindingRef: `opaque-${bindingId}`,
      runtime: 'claude',
      identityRef: 'corp/a:dev%2Fone',
      launchKey: launch.launchKey,
      launchDescriptorDigest: launch.descriptorDigest,
      artifactKey: launch.artifactKey,
      manifestKey: launch.manifestKey,
      projectRef: 'p',
      repositoryRef: 'r',
      worktreeRef: 'w',
      createdAt: instant,
      expiresAt: expires,
    }),
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  };
}
function record(overrides: Partial<SessionRecordV1> = {}): SessionRecordV1 {
  return {
    schemaVersion: 1,
    recordId: 'record-abc',
    runtimeQualifiedId: 'claude:abc',
    runtime: 'claude',
    identity,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: { kind: 'native-id', value: 'abc' },
    launch,
    location: {
      cwd: 'C:/repo',
      project: 'project',
      repository: 'repository',
      worktree: 'worktree',
    },
    metadata: { title: 'title', model: 'model', effort: 'high' },
    liveness: 'inactive',
    process: null,
    workflow: {
      status: 'paused',
      inbox: false,
      nextAction: null,
      priority: 2,
      note: null,
      relatedIssue: null,
      relatedReview: null,
    },
    resume: { state: 'resumable', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
    timestamps: {
      createdAt: instant,
      updatedAt: instant,
      lastActivityAt: instant,
    },
    lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    ...overrides,
  };
}

it('derives one native binding identity from identity, runtime, and root digest', () => {
  expect(deriveNativeBindingRef(identity, 'claude', digest)).toBe(
    deriveNativeBindingRef({ ...identity }, 'claude', digest),
  );
  expect(deriveNativeBindingRef(identity, 'pi', digest)).not.toBe(
    deriveNativeBindingRef(identity, 'claude', digest),
  );
});

it('lists private lifecycle bindings so pending events can be consumed', async () => {
  const store = new SessionStore(await temporary());
  await store.saveLifecycleBinding(lifecycleBindingRecord('binding-z'));
  await store.saveLifecycleBinding(lifecycleBindingRecord('binding-a'));
  expect(await store.listLifecycleBindingIds()).toEqual(['binding-z', 'binding-a']);
});

it('persists process identity and complete workflow metadata', () => {
  const parsed = parseSessionRecordV1({
    ...record(),
    process: { pid: 4312, startFingerprint: '2025-01-02T03:04:05.000Z' },
    workflow: {
      status: 'unfinished',
      inbox: true,
      nextAction: 'finish tests',
      note: 'handoff',
      relatedIssue: 'GH-12',
      relatedReview: 'PR-7',
      priority: 1,
    },
  });
  expect(parsed.process).toEqual({ pid: 4312, startFingerprint: '2025-01-02T03:04:05.000Z' });
  expect(parsed.workflow).toMatchObject({
    nextAction: 'finish tests',
    relatedIssue: 'GH-12',
    relatedReview: 'PR-7',
  });
});

it('rejects impossible canonical dates and unknown sensitive keys', () => {
  expect(() =>
    parseSessionRecordV1({
      ...record(),
      timestamps: {
        ...record().timestamps,
        createdAt: '2025-02-30T00:00:00.000Z',
      },
    }),
  ).toThrowError(SessionError);
  expect(() =>
    parseSessionRecordV1({
      ...record(),
      metadata: { ...record().metadata, transcript: 'secret' },
    }),
  ).toThrowError(SessionError);
});

it('persists injective domain+name+runtime partitions', async () => {
  const store = new SessionStore(await temporary());
  const left = store.registryPath({ domain: 'a/b', name: 'c' }, 'claude'),
    right = store.registryPath({ domain: 'a', name: 'b/c' }, 'claude');
  expect(left).not.toBe(right);
  await store.put(record());
  expect(await stat(store.registryPath(identity, 'claude'))).toBeDefined();
});

it('serializes concurrent read-modify-write transactions', async () => {
  const store = new SessionStore(await temporary());
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.put(
        record({
          recordId: `r-${index}`,
          runtimeQualifiedId: `claude:${index}`,
          nativeSessionRef: { kind: 'native-id', value: `${index}` },
        }),
      ),
    ),
  );
  expect((await store.read(identity, 'claude')).records).toHaveLength(20);
});

it('retries ownership validation when Windows temporarily denies a lock owner read', async () => {
  const root = await temporary();
  let ownerReadWasDenied = false,
    renameWasDenied = false;
  const store = new SessionStore(root, {
    releaseLock: {
      readOwner: async (file) => {
        if (renameWasDenied && !ownerReadWasDenied) {
          ownerReadWasDenied = true;
          throw Object.assign(new Error('temporarily denied'), { code: 'EPERM' });
        }
        return JSON.parse(await readFile(file, 'utf8')) as unknown;
      },
      rename: async (source, target) => {
        if (!renameWasDenied) {
          renameWasDenied = true;
          throw Object.assign(new Error('temporarily denied'), { code: 'EPERM' });
        }
        await rename(source, target);
      },
      wait: async () => undefined,
    },
  });
  const lock = `${store.registryPath(identity, 'claude')}.lock`;

  await expect(store.put(record())).resolves.toMatchObject({ recordId: 'record-abc' });
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(renameWasDenied).toBe(true);
  expect(ownerReadWasDenied).toBe(true);
});

it('removes a newly-created lock when owner initialization fails', async () => {
  const root = await temporary();
  let calls = 0;
  const store = new SessionStore(root, {
    now: () => {
      calls += 1;
      if (calls === 2) {
        throw new Error('clock failed');
      }
      return 1;
    },
  });
  await expect(store.put(record())).rejects.toThrow('clock failed');
  await expect(stat(`${store.registryPath(identity, 'claude')}.lock`)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('recovers an aged orphaned session lock initialization without waiting', async () => {
  const root = await temporary(),
    now = Date.now();
  const store = new SessionStore(root, { now: () => now, staleLockMs: 100, lockWaitMs: 10 });
  const lock = `${store.registryPath(identity, 'claude')}.lock`;
  await mkdir(lock, { recursive: true });
  await utimes(lock, (now - 1_000) / 1_000, (now - 1_000) / 1_000);
  await expect(store.put(record())).resolves.toMatchObject({ recordId: 'record-abc' });
});

it('never takes over an aged lease while its owner PID may still be alive', async () => {
  const root = await temporary(),
    now = Date.now();
  const store = new SessionStore(root, {
    now: () => now,
    staleLockMs: 10,
    lockWaitMs: 0,
    isPidAlive: () => true,
  });
  const lock = `${store.registryPath(identity, 'claude')}.lock`,
    token = 'live-owner';
  await mkdir(lock, { recursive: true });
  await writeFile(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: 4242, ownerToken: token, acquiredAt: now - 10_000 }),
  );
  await writeFile(path.join(lock, `lease-${token}`), '');
  await utimes(path.join(lock, `lease-${token}`), (now - 10_000) / 1000, (now - 10_000) / 1000);
  await expect(store.put(record())).rejects.toMatchObject({ code: 'SESSION_LOCK_TIMEOUT' });
  await expect(stat(lock)).resolves.toBeDefined();
});

it('prevents a delayed session lock initializer from disturbing its successor', async () => {
  const root = await temporary();
  let now = Date.now(),
    releaseInitializer!: () => void,
    initializerStarted!: () => void,
    releaseSuccessor!: () => void,
    successorStarted!: () => void;
  const initializerPaused = new Promise<void>((resolve) => {
    initializerStarted = resolve;
  });
  const resumeInitializer = new Promise<void>((resolve) => {
    releaseInitializer = resolve;
  });
  const successorPaused = new Promise<void>((resolve) => {
    successorStarted = resolve;
  });
  const resumeSuccessor = new Promise<void>((resolve) => {
    releaseSuccessor = resolve;
  });
  const first = new SessionStore(root, {
    now: () => now,
    staleLockMs: 100,
    lockWaitMs: 2_000,
    processId: 101,
    afterLockInitializerCreated: async () => {
      initializerStarted();
      await resumeInitializer;
    },
  });
  const file = first.registryPath(identity, 'claude'),
    lock = `${file}.lock`;
  const delayed = first.put(record());
  await initializerPaused;
  now += 1_000;
  const successor = new SessionStore(root, {
    now: () => now,
    staleLockMs: 100,
    lockWaitMs: 2_000,
    processId: 202,
    isPidAlive: (pid) => (pid === 101 ? false : true),
  });
  const succeeding = successor.transaction(identity, 'claude', async (registry) => {
    successorStarted();
    await resumeSuccessor;
    return { registry, result: true };
  });
  await successorPaused;
  releaseInitializer();
  await expect(delayed).rejects.toMatchObject({ code: 'SESSION_LOCK_OWNERSHIP_LOST' });
  await expect(stat(lock)).resolves.toBeDefined();
  releaseSuccessor();
  await expect(succeeding).resolves.toBe(true);
});

it('keeps a corrupt registry untouched', async () => {
  const store = new SessionStore(await temporary()),
    file = store.registryPath(identity, 'claude');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{broken', 'utf8');
  await expect(store.put(record())).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('{broken');
});

it('ingests the runtime lifecycle contract through private binding authority', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => later);
  await store.saveNativeBinding(nativeBinding());
  const wire = createSessionLifecycleBindingV1({
    bindingId: 'binding',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: launch.launchKey,
    launchDescriptorDigest: launch.descriptorDigest,
    artifactKey: launch.artifactKey,
    manifestKey: launch.manifestKey,
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: instant,
    expiresAt: expires,
  });
  const binding: SessionLifecycleBindingRecordV1 = {
    schemaVersion: 1,
    binding: wire,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  };
  await store.saveLifecycleBinding(binding);
  const event = createSessionLifecycleEventV1({
    eventId: 'event-1',
    bindingId: 'binding',
    type: 'start',
    sequence: 1,
    timestamp: later,
    nativeSessionId: 'abc',
    nativeSessionRef: { kind: 'native-id', value: 'abc' },
    cwd: 'C:/evil',
    title: 'new',
    model: 'opus',
    effort: 'high',
    pid: 42,
    startFingerprint: 'start',
  });
  const ingested = await service.ingest(event);
  await service.ingest(event);
  expect(ingested.launch).toEqual(launch);
  expect(ingested.location.cwd).toBe('C:/repo');
  expect((await store.read(identity, 'claude')).recentEventIds).toEqual(['event-1']);
});

it('rejects an event after its private lifecycle binding expires', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => later);
  await store.saveNativeBinding(nativeBinding());
  const binding = createSessionLifecycleBindingV1({
    bindingId: 'expired-binding',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: launch.launchKey,
    launchDescriptorDigest: launch.descriptorDigest,
    artifactKey: launch.artifactKey,
    manifestKey: launch.manifestKey,
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: '2024-01-01T00:00:00.000Z',
    expiresAt: instant,
  });
  await store.saveLifecycleBinding({
    schemaVersion: 1,
    binding,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  });
  const event = createSessionLifecycleEventV1({
    eventId: 'expired-event',
    bindingId: binding.bindingId,
    type: 'start',
    sequence: 1,
    timestamp: later,
    nativeSessionId: 'abc',
    nativeSessionRef: { kind: 'native-id', value: 'abc' },
    cwd: 'C:/repo',
    title: null,
    model: null,
    effort: null,
    pid: 42,
    startFingerprint: 'start',
  });
  await expect(service.ingest(event)).rejects.toMatchObject({
    code: 'SESSION_LIFECYCLE_BINDING_EXPIRED',
  });
});

it('quarantines an expired lifecycle event for diagnosis and continues', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => later);
  await store.saveNativeBinding(nativeBinding());
  const binding = createSessionLifecycleBindingV1({
    bindingId: 'expired-directory',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: launch.launchKey,
    launchDescriptorDigest: launch.descriptorDigest,
    artifactKey: launch.artifactKey,
    manifestKey: launch.manifestKey,
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: '2024-01-01T00:00:00.000Z',
    expiresAt: instant,
  });
  await store.saveLifecycleBinding({
    schemaVersion: 1,
    binding,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  });
  const directory = store.eventDirectory(binding.bindingId),
    file = path.join(directory, 'expired.json');
  await mkdir(directory, { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      createSessionLifecycleEventV1({
        eventId: 'expired-directory-event',
        bindingId: binding.bindingId,
        type: 'activity',
        sequence: 1,
        timestamp: later,
        nativeSessionId: 'abc',
        nativeSessionRef: { kind: 'native-id', value: 'abc' },
        cwd: 'C:/repo',
        title: null,
        model: null,
        effort: null,
        pid: 42,
        startFingerprint: 'start',
      }),
    ),
  );
  await expect(
    new LifecycleEventDirectoryConsumer(store, service).consume(binding.bindingId),
  ).resolves.toBe(0);
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  const quarantined = (await readdir(directory)).find((name) =>
    name.includes('SESSION_LIFECYCLE_BINDING_EXPIRED'),
  );
  expect(quarantined).toBeDefined();
  expect(await readFile(path.join(directory, quarantined!), 'utf8')).toContain(
    'expired-directory-event',
  );
});

it('refuses an event directory replaced by an attacker link immediately before enumeration', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => instant);
  await store.saveNativeBinding(nativeBinding());
  await store.saveLifecycleBinding(lifecycleBindingRecord('replaced-queue'));
  const directory = store.eventDirectory('replaced-queue'),
    displaced = `${directory}-original`,
    attacker = await temporary();
  await mkdir(directory, { recursive: true });
  const attackerEvent = path.join(attacker, 'attacker.json');
  await writeFile(
    attackerEvent,
    JSON.stringify(
      createSessionLifecycleEventV1({
        eventId: 'attacker-event',
        bindingId: 'replaced-queue',
        type: 'start',
        sequence: 1,
        timestamp: instant,
        nativeSessionId: 'stolen',
        nativeSessionRef: { kind: 'native-id', value: 'stolen' },
        cwd: 'C:/attacker',
        title: null,
        model: null,
        effort: null,
        pid: 99,
        startFingerprint: 'attacker',
      }),
    ),
  );
  const consumer = new LifecycleEventDirectoryConsumer(
    store,
    service,
    1_000,
    1024 * 1024,
    async () => {
      await rename(directory, displaced);
      await symlink(attacker, directory, 'junction');
    },
  );

  await expect(consumer.consume('replaced-queue')).rejects.toMatchObject({
    code: 'SESSION_UNSAFE_EVENT_DIRECTORY',
  });
  await expect(service.show('claude:stolen')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  expect(await readFile(attackerEvent, 'utf8')).toContain('attacker-event');
});

it('quarantines unsafe lifecycle entries and consumes a later valid event', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => instant);
  await store.saveNativeBinding(nativeBinding());
  await store.saveLifecycleBinding(lifecycleBindingRecord('unsafe-queue'));
  const directory = store.eventDirectory('unsafe-queue'),
    symlinkTarget = path.join(await temporary(), 'target.json');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, '0001.json'), Buffer.alloc(1024 * 1024 + 1));
  await writeFile(symlinkTarget, 'must not be read or changed');
  await symlink(symlinkTarget, path.join(directory, '0002.json'), 'file');
  await writeFile(
    path.join(directory, '0003.json'),
    JSON.stringify(
      createSessionLifecycleEventV1({
        eventId: 'valid-after-unsafe',
        bindingId: 'unsafe-queue',
        type: 'start',
        sequence: 1,
        timestamp: instant,
        nativeSessionId: 'abc',
        nativeSessionRef: { kind: 'native-id', value: 'abc' },
        cwd: 'C:/repo',
        title: null,
        model: null,
        effort: null,
        pid: 42,
        startFingerprint: 'start',
      }),
    ),
  );

  await expect(
    new LifecycleEventDirectoryConsumer(store, service).consume('unsafe-queue'),
  ).resolves.toBe(1);
  expect((await service.show('claude:abc')).recordId).toBeDefined();
  const quarantined = (await readdir(directory)).filter((name) =>
    name.includes('SESSION_UNSAFE_EVENT'),
  );
  expect(quarantined).toHaveLength(2);
  expect(quarantined.every((name) => !name.endsWith('.json'))).toBe(true);
  expect(await readFile(symlinkTarget, 'utf8')).toBe('must not be read or changed');
});

it('quarantines malformed lifecycle JSON and consumes later valid events', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => instant);
  await store.saveNativeBinding(nativeBinding());
  await store.saveLifecycleBinding(lifecycleBindingRecord('malformed-queue'));
  const directory = store.eventDirectory('malformed-queue'),
    malformed = '{not-json';
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, '0001.json'), malformed);
  await writeFile(
    path.join(directory, '0002.json'),
    JSON.stringify(
      createSessionLifecycleEventV1({
        eventId: 'valid-after-malformed',
        bindingId: 'malformed-queue',
        type: 'start',
        sequence: 1,
        timestamp: instant,
        nativeSessionId: 'abc',
        nativeSessionRef: { kind: 'native-id', value: 'abc' },
        cwd: 'C:/repo',
        title: null,
        model: null,
        effort: null,
        pid: 42,
        startFingerprint: 'start',
      }),
    ),
  );
  await expect(
    new LifecycleEventDirectoryConsumer(store, service).consume('malformed-queue'),
  ).resolves.toBe(1);
  expect((await service.show('claude:abc')).recordId).toBeDefined();
  const quarantined = (await readdir(directory)).find((name) =>
    name.includes('SESSION_EVENT_JSON_PARSE_FAILED'),
  );
  expect(quarantined).toBeDefined();
  expect(await readFile(path.join(directory, quarantined!), 'utf8')).toBe(malformed);
});

it('rejects a different native session after a new lifecycle is bound', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store);
  await store.saveNativeBinding(nativeBinding());
  const wire = createSessionLifecycleBindingV1({
    bindingId: 'new-binding',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: launch.launchKey,
    launchDescriptorDigest: launch.descriptorDigest,
    artifactKey: launch.artifactKey,
    manifestKey: launch.manifestKey,
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: instant,
    expiresAt: expires,
  });
  await store.saveLifecycleBinding({
    schemaVersion: 1,
    binding: wire,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  });
  const event = (id: string, nativeId: string, sequence: number) =>
    createSessionLifecycleEventV1({
      eventId: id,
      bindingId: 'new-binding',
      type: 'activity',
      sequence,
      timestamp: later,
      nativeSessionId: nativeId,
      nativeSessionRef: { kind: 'native-id', value: nativeId },
      cwd: 'C:/repo',
      title: null,
      model: null,
      effort: null,
      pid: 42,
      startFingerprint: 'start',
    });
  await service.ingest(event('first', 'abc', 1));
  await expect(service.ingest(event('second', 'other', 2))).rejects.toMatchObject({
    code: 'SESSION_BINDING_MISMATCH',
  });
});

it('rejects the first event when a resume lifecycle is prebound', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store);
  await store.saveNativeBinding(nativeBinding());
  const wire = createSessionLifecycleBindingV1({
    bindingId: 'resume-binding',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: launch.launchKey,
    launchDescriptorDigest: launch.descriptorDigest,
    artifactKey: launch.artifactKey,
    manifestKey: launch.manifestKey,
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: instant,
    expiresAt: expires,
  });
  await store.saveLifecycleBinding({
    schemaVersion: 1,
    binding: wire,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: { kind: 'native-id', value: 'expected' },
    launch,
    location: record().location,
  });
  await store.put(
    record({
      runtimeQualifiedId: 'claude:expected',
      nativeSessionRef: { kind: 'native-id', value: 'expected' },
    }),
  );
  await expect(
    service.ingest(
      createSessionLifecycleEventV1({
        eventId: 'resume-first',
        bindingId: 'resume-binding',
        type: 'start',
        sequence: 1,
        timestamp: later,
        nativeSessionId: 'other',
        nativeSessionRef: { kind: 'native-id', value: 'other' },
        cwd: 'C:/repo',
        title: null,
        model: null,
        effort: null,
        pid: 42,
        startFingerprint: 'start',
      }),
    ),
  ).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' });
});

it('removes an event-directory file only after durable lifecycle ingestion', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store);
  await store.saveNativeBinding(nativeBinding());
  const wire = createSessionLifecycleBindingV1({
    bindingId: 'directory-binding',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: 'key',
    launchDescriptorDigest: digest,
    artifactKey: 'artifact',
    manifestKey: 'manifest',
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: instant,
    expiresAt: expires,
  });
  await store.saveLifecycleBinding({
    schemaVersion: 1,
    binding: wire,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: { kind: 'native-id', value: 'abc' },
    launch,
    location: record().location,
  });
  const directory = store.eventDirectory('directory-binding'),
    file = path.join(directory, '0001.json');
  await mkdir(directory, { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      createSessionLifecycleEventV1({
        eventId: 'directory-event',
        bindingId: 'directory-binding',
        type: 'activity',
        sequence: 1,
        timestamp: later,
        nativeSessionId: 'abc',
        nativeSessionRef: { kind: 'native-id', value: 'abc' },
        cwd: 'C:/repo',
        title: null,
        model: null,
        effort: null,
        pid: 42,
        startFingerprint: 'start',
      }),
    ),
  );
  expect(
    await new LifecycleEventDirectoryConsumer(store, service).consume('directory-binding'),
  ).toBe(1);
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await service.show('claude:abc')).liveness).toBe('active');
});

it('accepts sequence one when a resumed session moves to a new lifecycle binding', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store);
  await store.saveNativeBinding(nativeBinding());
  await store.put(
    record({ lifecycle: { bindingId: 'old-binding', sequence: 8, timestamp: instant } }),
  );
  const binding = createSessionLifecycleBindingV1({
    bindingId: 'new-ordering-domain',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: launch.launchKey,
    launchDescriptorDigest: launch.descriptorDigest,
    artifactKey: launch.artifactKey,
    manifestKey: launch.manifestKey,
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: instant,
    expiresAt: expires,
  });
  await store.saveLifecycleBinding({
    schemaVersion: 1,
    binding,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: { kind: 'native-id', value: 'abc' },
    launch,
    location: record().location,
  });
  const resumed = await service.ingest(
    createSessionLifecycleEventV1({
      eventId: 'new-domain-event',
      bindingId: 'new-ordering-domain',
      type: 'start',
      sequence: 1,
      timestamp: later,
      nativeSessionId: 'abc',
      nativeSessionRef: { kind: 'native-id', value: 'abc' },
      cwd: 'C:/repo',
      title: null,
      model: null,
      effort: null,
      pid: 77,
      startFingerprint: 'new-process',
    }),
  );
  expect(resumed.lifecycle).toMatchObject({ bindingId: 'new-ordering-domain', sequence: 1 });
});

it('retains shutdown process evidence for later native activity verification', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store);
  await store.saveNativeBinding(nativeBinding());
  const binding = createSessionLifecycleBindingV1({
    bindingId: 'shutdown-binding',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: launch.launchKey,
    launchDescriptorDigest: launch.descriptorDigest,
    artifactKey: launch.artifactKey,
    manifestKey: launch.manifestKey,
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: instant,
    expiresAt: expires,
  });
  await store.saveLifecycleBinding({
    schemaVersion: 1,
    binding,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  });
  const shutdown = await service.ingest(
    createSessionLifecycleEventV1({
      eventId: 'shutdown-event',
      bindingId: 'shutdown-binding',
      type: 'shutdown',
      sequence: 1,
      timestamp: later,
      nativeSessionId: 'abc',
      nativeSessionRef: { kind: 'native-id', value: 'abc' },
      cwd: 'C:/repo',
      title: null,
      model: null,
      effort: null,
      pid: 88,
      startFingerprint: 'process-birth',
    }),
  );
  expect(shutdown).toMatchObject({
    liveness: 'inactive',
    process: { pid: 88, startFingerprint: 'process-birth' },
  });
});

it('allows concurrent lifecycle consumers to durably consume one event once', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store);
  await store.saveNativeBinding(nativeBinding());
  const binding = createSessionLifecycleBindingV1({
    bindingId: 'concurrent-binding',
    bindingRef: 'opaque',
    runtime: 'claude',
    identityRef: 'corp/a:dev%2Fone',
    launchKey: launch.launchKey,
    launchDescriptorDigest: launch.descriptorDigest,
    artifactKey: launch.artifactKey,
    manifestKey: launch.manifestKey,
    projectRef: 'p',
    repositoryRef: 'r',
    worktreeRef: 'w',
    createdAt: instant,
    expiresAt: expires,
  });
  await store.saveLifecycleBinding({
    schemaVersion: 1,
    binding,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  });
  const directory = store.eventDirectory('concurrent-binding');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, '0001.json'),
    JSON.stringify(
      createSessionLifecycleEventV1({
        eventId: 'concurrent-event',
        bindingId: 'concurrent-binding',
        type: 'start',
        sequence: 1,
        timestamp: later,
        nativeSessionId: 'abc',
        nativeSessionRef: { kind: 'native-id', value: 'abc' },
        cwd: 'C:/repo',
        title: null,
        model: null,
        effort: null,
        pid: 42,
        startFingerprint: 'start',
      }),
    ),
  );
  await expect(
    Promise.all([
      new LifecycleEventDirectoryConsumer(store, service).consume('concurrent-binding'),
      new LifecycleEventDirectoryConsumer(store, service).consume('concurrent-binding'),
    ]),
  ).resolves.toEqual([1, 0]);
  expect((await store.read(identity, 'claude')).records).toHaveLength(1);
});

it('plans successful Claude resume and rejects root mismatch', async () => {
  const store = new SessionStore(await temporary());
  await store.saveNativeBinding(nativeBinding());
  const deps = {
    resolveConfiguredRoot: async () => ({
      root: 'C:/native',
      canonicalRootDigest: digest,
      identity,
      runtime: 'claude' as const,
    }),
    verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
  };
  const planned = await planResume(store, record(), deps);
  expect(planned.launch).toEqual(launch);
  expect(planned.newLaunchRequired).toBe(true);
  expect(planned.previousLaunch).toEqual({
    launchKey: launch.launchKey,
    descriptorDigest: launch.descriptorDigest,
  });
  await expect(
    planResume(store, record(), {
      ...deps,
      resolveConfiguredRoot: async () => ({
        root: 'C:/native',
        canonicalRootDigest: 'b'.repeat(64),
        identity,
        runtime: 'claude' as const,
      }),
    }),
  ).rejects.toMatchObject({ code: 'SESSION_RESUME_ROOT_MISMATCH' });
});

it('durably records successful and failed resume verification and rechecks cached states', async () => {
  const store = new SessionStore(await temporary());
  await store.saveNativeBinding(nativeBinding());
  await store.put(
    record({
      liveness: 'active',
      resume: {
        state: 'unavailable',
        diagnostic: 'old',
        lastVerifiedAt: instant,
        lastPlanDigest: null,
      },
    }),
  );
  const deps = {
    resolveConfiguredRoot: async () => ({
      root: 'C:/native',
      canonicalRootDigest: digest,
      identity,
      runtime: 'claude' as const,
    }),
    verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
  };
  const plan = await planResume(store, await new SessionService(store).show('record-abc'), deps);
  const successful = await new SessionService(store).show('record-abc');
  expect(successful.resume).toMatchObject({
    state: 'resumable',
    diagnostic: null,
    lastPlanDigest: plan.confirmationDigest,
  });
  expect(successful.resume.lastVerifiedAt).not.toBeNull();

  await expect(
    planResume(store, successful, {
      ...deps,
      verifyNativeTarget: async () => ({ valid: true, activity: 'unavailable' as const }),
    }),
  ).rejects.toMatchObject({ code: 'SESSION_RESUME_ACTIVITY_UNAVAILABLE' });
  const failed = await new SessionService(store).show('record-abc');
  expect(failed.resume).toMatchObject({
    state: 'unavailable',
    diagnostic: 'SESSION_RESUME_ACTIVITY_UNAVAILABLE',
    lastPlanDigest: null,
  });
  expect(failed.resume.lastVerifiedAt).not.toBeNull();
});

it('preserves a resume validation failure when blocked-state persistence also fails', async () => {
  const store = new SessionStore(await temporary());
  await store.saveNativeBinding(nativeBinding());
  vi.spyOn(store, 'transaction').mockRejectedValue(new Error('blocked persistence failed'));
  await expect(
    planResume(store, record(), {
      resolveConfiguredRoot: async () => ({
        root: 'C:/native',
        canonicalRootDigest: 'b'.repeat(64),
        identity,
        runtime: 'claude',
      }),
      verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' }),
    }),
  ).rejects.toMatchObject({ code: 'SESSION_RESUME_ROOT_MISMATCH' });
});

it('records unexpected resume failures as unavailable without replacing the primary error', async () => {
  const store = new SessionStore(await temporary());
  await store.saveNativeBinding(nativeBinding());
  await store.put(record());
  const operationalFailure = new Error('provider inspection failed');
  await expect(
    planResume(store, record(), {
      resolveConfiguredRoot: async () => {
        throw operationalFailure;
      },
      verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' }),
    }),
  ).rejects.toBe(operationalFailure);
  await expect(new SessionService(store).show('record-abc')).resolves.toMatchObject({
    resume: { state: 'unavailable', diagnostic: 'SESSION_RESUME_FAILED' },
  });

  const persistenceFailure = new Error('resume persistence failed');
  vi.spyOn(store, 'transaction').mockRejectedValue(persistenceFailure);
  const secondOperationalFailure = new Error('provider failed again');
  await expect(
    planResume(store, record(), {
      resolveConfiguredRoot: async () => {
        throw secondOperationalFailure;
      },
      verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' }),
    }),
  ).rejects.toBe(secondOperationalFailure);
});

it('propagates resumable-state persistence failures without attempting a blocked write', async () => {
  const store = new SessionStore(await temporary());
  await store.saveNativeBinding(nativeBinding());
  const transaction = vi
    .spyOn(store, 'transaction')
    .mockRejectedValue(new Error('resumable persistence failed'));
  await expect(
    planResume(store, record(), {
      resolveConfiguredRoot: async () => ({
        root: 'C:/native',
        canonicalRootDigest: digest,
        identity,
        runtime: 'claude',
      }),
      verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' }),
    }),
  ).rejects.toThrow('resumable persistence failed');
  expect(transaction).toHaveBeenCalledTimes(1);
});

it('requires exact Pi account binding verification', async () => {
  const store = new SessionStore(await temporary()),
    piIdentity = { domain: 'local', name: 'pi' };
  await store.saveNativeBinding(
    nativeBinding({
      runtime: 'pi',
      identity: piIdentity,
      accountBindingRef: 'account:opaque',
    }),
  );
  const pi = record({
    runtime: 'pi',
    runtimeQualifiedId: 'pi:abc',
    identity: piIdentity,
    nativeSessionRef: {
      kind: 'root-relative-file',
      value: 'sessions/abc.jsonl',
    },
  });
  const base = {
    resolveConfiguredRoot: async () => ({
      root: 'C:/pi',
      canonicalRootDigest: digest,
      identity: piIdentity,
      runtime: 'pi' as const,
    }),
    verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
  };
  expect(
    (
      await planResume(store, pi, {
        ...base,
        verifyAccountBinding: async () => 'verified',
      })
    ).runtime,
  ).toBe('pi');
  await expect(planResume(store, pi, base)).rejects.toMatchObject({
    code: 'SESSION_RESUME_ACCOUNT_UNAVAILABLE',
  });
  await expect(
    planResume(store, pi, { ...base, verifyAccountBinding: async () => 'mismatch' }),
  ).rejects.toMatchObject({ code: 'SESSION_RESUME_ACCOUNT_MISMATCH' });
  await expect(
    planResume(store, pi, {
      ...base,
      verifyAccountBinding: async () => 'duplicate',
    }),
  ).rejects.toMatchObject({ code: 'SESSION_RESUME_ACCOUNT_DUPLICATE' });
});

it('fails closed when native resume activity cannot be inspected', async () => {
  const store = new SessionStore(await temporary());
  await store.saveNativeBinding(nativeBinding());
  await expect(
    planResume(store, record(), {
      resolveConfiguredRoot: async () => ({
        root: 'C:/native',
        canonicalRootDigest: digest,
        identity,
        runtime: 'claude',
      }),
      verifyNativeTarget: async () => ({ valid: true, activity: 'unavailable' }),
    }),
  ).rejects.toMatchObject({ code: 'SESSION_RESUME_ACTIVITY_UNAVAILABLE' });
});

it('reconcile scopes observations to context identity and deduplicates scanners', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => later),
    otherIdentity = { domain: 'other', name: 'dev' };
  await store.put(record());
  await store.put(
    record({
      identity: otherIdentity,
      recordId: 'record-other',
      runtimeQualifiedId: 'claude:other',
      nativeSessionRef: { kind: 'native-id', value: 'other' },
    }),
  );
  const scanner = {
    runtime: 'claude' as const,
    scan: async () => ({
      status: 'available' as const,
      sessions: [],
      diagnostic: null,
    }),
  };
  const context = { identity, nativeBindingRef: 'native:opaque', runtime: 'claude' as const };
  const observations = await service.reconcile([
    { scanner, context },
    { scanner, context },
  ]);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    identityRef: 'corp/a:dev%2Fone',
    workflowStatus: 'paused',
    inbox: false,
    dispositionAt: null,
  });
});

it('emits lifecycle-only Pi observations without duplicating Claude scanner observations', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => later);
  await store.put(record());
  await store.put(
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:pi-one',
      recordId: 'pi-one',
      identity: { domain: 'local', name: 'pi' },
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/pi-one.jsonl' },
    }),
  );
  const observations = await service.reconcile([
    {
      scanner: {
        runtime: 'claude',
        scan: async () => ({
          status: 'unavailable' as const,
          sessions: [],
          diagnostic: 'CLAUDE_UNAVAILABLE',
        }),
      },
      context: { identity, nativeBindingRef: 'native:opaque', runtime: 'claude' },
    },
  ]);
  expect(observations.filter((item) => item.runtime === 'claude')).toHaveLength(1);
  expect(observations.filter((item) => item.runtime === 'pi')).toMatchObject([
    {
      runtimeQualifiedId: 'pi:pi-one',
      source: 'sessions:lifecycle',
      capturedAt: instant,
      freshUntil: instant,
    },
  ]);
});

it('preserves active Pi lifecycle state without a process inspector and publishes lifecycle-time freshness', async () => {
  const store = new SessionStore(await temporary());
  const active = record({
    runtime: 'pi',
    runtimeQualifiedId: 'pi:lifecycle-only',
    recordId: 'pi-lifecycle-only',
    identity: { domain: 'local', name: 'pi' },
    nativeSessionRef: { kind: 'root-relative-file', value: 'lifecycle-only.jsonl' },
    liveness: 'active',
    process: { pid: 42, startFingerprint: 'start' },
    lifecycle: { bindingId: 'binding', sequence: 3, timestamp: instant },
  });
  await store.put(active);
  const service = new SessionService(store, () => later);
  const observations = await service.reconcile([]);
  expect(await service.show('pi:lifecycle-only')).toEqual(active);
  expect(observations[0]).toMatchObject({
    capturedAt: instant,
    freshUntil: instant,
    lifecycleState: 'active',
  });
});

it('keeps an exact-live Pi process active and captures its verification at reconcile time', async () => {
  const store = new SessionStore(await temporary());
  await store.put(
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:live',
      recordId: 'pi-live',
      identity: { domain: 'local', name: 'pi' },
      nativeSessionRef: { kind: 'root-relative-file', value: 'live.jsonl' },
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
    }),
  );
  const observations = await new SessionService(store, () => later, {
    inspect: async (pid) => ({ status: 'present', pid, startFingerprint: 'start' }),
  }).reconcile([]);
  expect((await store.partitions())[0]?.records[0]).toMatchObject({
    liveness: 'active',
    process: { pid: 42 },
  });
  expect(observations[0]).toMatchObject({
    capturedAt: later,
    freshUntil: later,
    lifecycleState: 'active',
  });
});

it('does not apply a stale Pi process inspection after a newer process tuple is committed', async () => {
  const store = new SessionStore(await temporary());
  const original = record({
    runtime: 'pi',
    runtimeQualifiedId: 'pi:race',
    recordId: 'pi-race',
    identity: { domain: 'local', name: 'pi' },
    nativeSessionRef: { kind: 'root-relative-file', value: 'race.jsonl' },
    liveness: 'active',
    process: { pid: 42, startFingerprint: 'old' },
  });
  await store.put(original);
  let inspected!: () => void, release!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  const continueInspection = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconciling = new SessionService(store, () => later, {
    inspect: async () => {
      inspected();
      await continueInspection;
      return { status: 'absent' };
    },
  }).reconcile([]);
  await inspectionStarted;
  await store.put({
    ...original,
    liveness: 'active',
    process: { pid: 77, startFingerprint: 'new' },
    timestamps: { ...original.timestamps, updatedAt: later },
  });
  release();
  await reconciling;
  expect(await new SessionService(store).show('pi:race')).toMatchObject({
    liveness: 'active',
    process: { pid: 77, startFingerprint: 'new' },
  });
});

it('recovers Pi process inspection from unknown to exact before observing absence', async () => {
  const store = new SessionStore(await temporary());
  await store.put(
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:recover',
      recordId: 'pi-recover',
      identity: { domain: 'local', name: 'pi' },
      nativeSessionRef: { kind: 'root-relative-file', value: 'recover.jsonl' },
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
    }),
  );
  const inspections = [
    { status: 'unknown' as const },
    { status: 'present' as const, pid: 42, startFingerprint: 'start' },
    { status: 'absent' as const },
  ];
  const service = new SessionService(store, () => later, {
    inspect: async () => inspections.shift()!,
  });

  await service.reconcile([]);
  expect(await service.show('pi:recover')).toMatchObject({
    liveness: 'unknown',
    process: { pid: 42, startFingerprint: 'start' },
  });
  await service.reconcile([]);
  expect(await service.show('pi:recover')).toMatchObject({
    liveness: 'active',
    process: { pid: 42, startFingerprint: 'start' },
  });
  await service.reconcile([]);
  expect(await service.show('pi:recover')).toMatchObject({
    liveness: 'inactive',
    process: null,
  });
});

it('marks an absent Pi process inactive and clears its process metadata', async () => {
  const store = new SessionStore(await temporary());
  await store.put(
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:dead',
      recordId: 'pi-dead',
      identity: { domain: 'local', name: 'pi' },
      nativeSessionRef: { kind: 'root-relative-file', value: 'dead.jsonl' },
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
    }),
  );
  const service = new SessionService(store, () => later, {
    inspect: async () => ({ status: 'absent' }),
  });
  const observations = await service.reconcile([]);
  expect(await service.show('pi:dead')).toMatchObject({ liveness: 'inactive', process: null });
  expect(observations[0]).toMatchObject({
    capturedAt: later,
    freshUntil: later,
    lifecycleState: 'shutdown',
  });
});

it('treats a reused Pi PID with a mismatched fingerprint as liveness unknown', async () => {
  const store = new SessionStore(await temporary());
  await store.put(
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:reused',
      recordId: 'pi-reused',
      identity: { domain: 'local', name: 'pi' },
      nativeSessionRef: { kind: 'root-relative-file', value: 'reused.jsonl' },
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
    }),
  );
  const service = new SessionService(store, () => later, {
    inspect: async (pid) => ({ status: 'present', pid, startFingerprint: 'different' }),
  });
  const observations = await service.reconcile([]);
  expect(await service.show('pi:reused')).toMatchObject({
    liveness: 'unknown',
    process: { pid: 42, startFingerprint: 'start' },
  });
  expect(observations[0]).toMatchObject({
    capturedAt: instant,
    freshUntil: instant,
    lifecycleState: 'unknown',
  });
});

it('preserves Pi process metadata when process inspection is unknown', async () => {
  const store = new SessionStore(await temporary());
  await store.put(
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:unknown',
      recordId: 'pi-unknown',
      identity: { domain: 'local', name: 'pi' },
      nativeSessionRef: { kind: 'root-relative-file', value: 'unknown.jsonl' },
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
    }),
  );
  const service = new SessionService(store, () => later, {
    inspect: async () => ({ status: 'unknown' }),
  });
  const observations = await service.reconcile([]);
  expect(await service.show('pi:unknown')).toMatchObject({
    liveness: 'unknown',
    process: { pid: 42, startFingerprint: 'start' },
  });
  expect(observations[0]).toMatchObject({ capturedAt: instant, freshUntil: instant });
});

it('marks a previously discovered process inactive when its exact source is available and empty', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => later);
  await store.saveNativeBinding(nativeBinding());
  const context = { identity, nativeBindingRef: 'native:opaque', runtime: 'claude' as const };
  await service.reconcile([
    {
      scanner: {
        runtime: 'claude',
        scan: async () => ({
          status: 'available' as const,
          sessions: [
            {
              nativeSessionId: 'gone',
              nativeSessionRef: { kind: 'native-id' as const, value: 'gone' },
              cwd: 'C:/repo',
              title: null,
              pid: 9,
              startFingerprint: 'fp',
            },
          ],
          diagnostic: null,
        }),
      },
      context,
    },
  ]);
  await service.reconcile([
    {
      scanner: {
        runtime: 'claude',
        scan: async () => ({ status: 'available' as const, sessions: [], diagnostic: null }),
      },
      context,
    },
  ]);
  expect(await service.show('claude:gone')).toMatchObject({ liveness: 'inactive', process: null });
});

it('distinguishes unavailable Claude discovery from an empty result', async () => {
  expect(
    (
      await new ClaudeActiveScanner(async () => ({
        available: false,
        exitCode: 1,
        stdout: '',
      })).scan()
    ).status,
  ).toBe('unavailable');
  const empty = await new ClaudeActiveScanner(async () => ({
    available: true,
    exitCode: 0,
    stdout: '[]',
  })).scan();
  expect(empty.status).toBe('available');
  expect(empty.sessions).toEqual([]);
});

it('reads maintained Pi v2 registry files and keeps the newest registration', async () => {
  const root = await temporary(),
    registry = path.join(await temporary(), 'active-sessions'),
    sessionFile = path.join(root, 'sessions', 'one.jsonl');
  await mkdir(path.dirname(sessionFile));
  await mkdir(registry);
  await writeFile(sessionFile, 'x');
  const entry = (registeredAt: string, name?: string) => ({
    version: 2,
    agent: 'pi',
    sessionId: 'one',
    sessionFile,
    cwd: root,
    ...(name === undefined ? {} : { name }),
    pid: 10,
    processStartedAt: instant,
    registeredAt,
  });
  await writeFile(path.join(registry, 'old.json'), JSON.stringify(entry(instant, 'old')));
  await writeFile(path.join(registry, 'new.json'), JSON.stringify(entry(later, 'new')));
  const result = await new PiV2ActiveRegistryScanner(
    root,
    registry,
    { inspect: async () => ({ startFingerprint: instant }) },
    () => Date.parse(later) + 1,
  ).scan();
  expect(result.sessions).toMatchObject([
    {
      nativeSessionId: 'one',
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/one.jsonl' },
      title: 'new',
      startFingerprint: instant,
    },
  ]);
});

it('normalizes the PowerShell round-trip process timestamp to the Windows fingerprint', async () => {
  const root = await temporary(),
    registry = path.join(await temporary(), 'active-sessions'),
    sessionFile = path.join(root, 'sessions', 'windows.jsonl'),
    windowsStartedAt = '2025-01-02T03:04:05.1234567Z',
    normalizedStartedAt = '2025-01-02T03:04:05.123Z';
  await mkdir(path.dirname(sessionFile));
  await mkdir(registry);
  await writeFile(sessionFile, 'x');
  await writeFile(
    path.join(registry, 'windows.json'),
    JSON.stringify({
      version: 2,
      agent: 'pi',
      sessionId: 'windows',
      sessionFile,
      cwd: root,
      pid: 10,
      processStartedAt: windowsStartedAt,
      registeredAt: later,
    }),
  );

  const result = await new PiV2ActiveRegistryScanner(
    root,
    registry,
    { inspect: async () => ({ startFingerprint: normalizedStartedAt }) },
    () => Date.parse(later) + 1,
  ).scan();

  expect(result.sessions).toMatchObject([
    { nativeSessionId: 'windows', startFingerprint: normalizedStartedAt },
  ]);
});

it('ignores known legacy Pi v1 records without weakening v2 validation', async () => {
  const root = await temporary(),
    registry = path.join(await temporary(), 'active-sessions'),
    sessionFile = path.join(root, 'sessions', 'current.jsonl');
  await mkdir(path.dirname(sessionFile));
  await mkdir(registry);
  await writeFile(sessionFile, 'x');
  await writeFile(
    path.join(registry, 'legacy.json'),
    JSON.stringify({
      version: 1,
      agent: 'pi',
      sessionId: 'legacy',
      sessionFile,
      cwd: root,
      pid: 9,
      registeredAt: instant,
    }),
  );
  await writeFile(
    path.join(registry, 'current.json'),
    JSON.stringify({
      version: 2,
      agent: 'pi',
      sessionId: 'current',
      sessionFile,
      cwd: root,
      pid: 10,
      processStartedAt: instant,
      registeredAt: later,
    }),
  );

  const result = await new PiV2ActiveRegistryScanner(
    root,
    registry,
    { inspect: async (pid) => (pid === 10 ? { startFingerprint: instant } : null) },
    () => Date.parse(later) + 1,
  ).scan();

  expect(result.sessions.map((session) => session.nativeSessionId)).toEqual(['current']);
});

it.each([
  ['unknown schema', { version: 3, processStartedAt: instant }],
  ['timestamp offset', { version: 2, processStartedAt: '2025-01-02T03:04:05.000+00:00' }],
  ['unsupported precision', { version: 2, processStartedAt: '2025-01-02T03:04:05.0000Z' }],
  ['invalid date', { version: 2, processStartedAt: '2025-02-30T03:04:05.000Z' }],
  ['future timestamp', { version: 2, processStartedAt: later }],
])('rejects %s in a Pi v2 registry record', async (_case, changed) => {
  const root = await temporary(),
    registry = path.join(await temporary(), 'active-sessions'),
    sessionFile = path.join(root, 'sessions', 'invalid.jsonl');
  await mkdir(path.dirname(sessionFile));
  await mkdir(registry);
  await writeFile(sessionFile, 'x');
  await writeFile(
    path.join(registry, 'invalid.json'),
    JSON.stringify(
      Object.assign(
        {
          version: 2,
          agent: 'pi',
          sessionId: 'invalid',
          sessionFile,
          cwd: root,
          pid: 10,
          processStartedAt: instant,
          registeredAt: instant,
        },
        changed,
      ),
    ),
  );

  await expect(
    new PiV2ActiveRegistryScanner(
      root,
      registry,
      { inspect: async () => ({ startFingerprint: instant }) },
      () => Date.parse(instant) + 1,
    ).scan(),
  ).rejects.toBeInstanceOf(SessionError);
});

it('treats a missing Pi registry directory as available empty by default', async () => {
  const result = await new PiV2ActiveRegistryScanner(
    await temporary(),
    path.join(await temporary(), 'missing'),
    { inspect: async () => null },
  ).scan();
  expect(result).toEqual({ status: 'available', sessions: [], diagnostic: null });
});

it('can explicitly report a missing Pi registry directory as unavailable', async () => {
  const result = await new PiV2ActiveRegistryScanner(
    await temporary(),
    path.join(await temporary(), 'missing'),
    { inspect: async () => null },
    { missingDirectory: 'unavailable' },
  ).scan();
  expect(result.status).toBe('unavailable');
  expect(result.diagnostic).toBe('PI_DISCOVERY_UNAVAILABLE');
});

it('rejects unsafe Pi registry and session files without reading another root', async () => {
  const root = await temporary(),
    registry = path.join(await temporary(), 'active-sessions'),
    outside = path.join(await temporary(), 'outside.jsonl');
  await mkdir(registry);
  await writeFile(outside, 'x');
  await writeFile(
    path.join(registry, 'outside.json'),
    JSON.stringify({
      version: 2,
      agent: 'pi',
      sessionId: 'one',
      sessionFile: outside,
      cwd: root,
      pid: 10,
      processStartedAt: instant,
      registeredAt: later,
    }),
  );
  await expect(
    new PiV2ActiveRegistryScanner(
      root,
      registry,
      { inspect: async () => ({ startFingerprint: instant }) },
      () => Date.parse(later) + 1,
    ).scan(),
  ).rejects.toMatchObject({ code: 'PI_SESSION_ROOT_ESCAPE' });
});
