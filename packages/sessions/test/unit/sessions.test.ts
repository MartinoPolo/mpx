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
import { createSessionLifecycleBinding, createSessionLifecycleEvent } from '@mpx/runtime-contracts';
import {
  LifecycleEventDirectoryConsumer,
  SessionError,
  SessionService,
  SessionStore,
  deriveNativeBindingRef,
  parseNativeBindingRecord,
  parseSessionRecord,
  parseSessionRegistry,
  planResume,
  verifyNativeResumeSeed,
  type LaunchSnapshot,
  type NativeBindingRecord,
  type ProcessInspection,
  type SessionLifecycleBindingRecord,
  type SessionRecord,
} from '../../src/index.js';

const instant = '2025-01-02T03:04:05.000Z',
  later = '2025-02-02T03:04:05.000Z',
  expires = '2099-01-01T00:00:00.000Z',
  digest = 'a'.repeat(64);
const identity = { domain: 'corp/a', name: 'dev%2Fone' };
const launch: LaunchSnapshot = {
  launchKey: 'key',
  descriptorDigest: digest,
  mode: 'interactive',
  selection: {
    location: { name: 'repo', canonicalRoot: 'C:/repo' },
    packs: ['development'],
    source: 'project',
  },
  executor: { kind: 'host' },
  workspace: 'workspace',
  networkPolicy: 'restricted',
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
function nativeBinding(overrides: Partial<NativeBindingRecord> = {}): NativeBindingRecord {
  return {
    schemaVersion: 1,
    ref: 'native:opaque',
    identity,
    runtime: 'claude',
    recordedRootDigest: digest,
    createdAt: instant,
    updatedAt: instant,
    ...overrides,
  };
}
function lifecycleBindingRecord(bindingId: string): SessionLifecycleBindingRecord {
  return {
    schemaVersion: 2,
    binding: createSessionLifecycleBinding({
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
function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 2,
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

it('rejects obsolete account authority fields instead of retaining a legacy reader', () => {
  expect(() =>
    parseNativeBindingRecord({ ...nativeBinding(), accountBindingRef: 'obsolete' }),
  ).toThrowError(expect.objectContaining({ code: 'SESSION_UNKNOWN_FIELD' }));
});

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
  const parsed = parseSessionRecord({
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
    parseSessionRecord({
      ...record(),
      timestamps: {
        ...record().timestamps,
        createdAt: '2025-02-30T00:00:00.000Z',
      },
    }),
  ).toThrowError(SessionError);
  expect(() =>
    parseSessionRecord({
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

it('reports obsolete registry authority as requiring a fresh MPX launch', () => {
  expect(() =>
    parseSessionRegistry({ schemaVersion: 1, records: [{ rights: 'legacy' }] }),
  ).toThrowError(
    expect.objectContaining({
      code: 'SESSION_STALE_REGISTRY_AUTHORITY',
      message: expect.stringMatching(/relaunch/i),
      remediation: expect.stringMatching(/fresh MPX launch/i),
    }),
  );
});

it('leaves obsolete current-root registry bytes unchanged while reporting relaunch', async () => {
  const root = await temporary();
  const store = new SessionStore(root);
  const registry = store.registryPath(identity, 'claude');
  const bytes = Buffer.from('{"schemaVersion":1,"records":[{"rights":"legacy"}]}\n');
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, bytes);

  await expect(store.read(identity, 'claude')).rejects.toMatchObject({
    code: 'SESSION_STALE_REGISTRY_AUTHORITY',
    message: expect.stringMatching(/relaunch/i),
  });
  expect(await readFile(registry)).toEqual(bytes);
});

it('creates fresh v2 authority without reading or changing the old v1 store', async () => {
  const root = await temporary();
  const store = new SessionStore(root);
  const oldRegistry = path.join(
    root,
    'sessions',
    'v1',
    'identities',
    `d-${Buffer.from(identity.domain).toString('base64url')}`,
    `n-${Buffer.from(identity.name).toString('base64url')}`,
    'claude',
    'registry.json',
  );
  const oldBytes = Buffer.from('{"schemaVersion":1,"records":[{"rights":"legacy"}]}\n');
  await mkdir(path.dirname(oldRegistry), { recursive: true });
  await writeFile(oldRegistry, oldBytes);

  await expect(store.read(identity, 'claude')).resolves.toMatchObject({ records: [] });
  await store.put(record());

  expect(store.registryPath(identity, 'claude')).toContain(
    `${path.sep}sessions${path.sep}v2${path.sep}`,
  );
  expect(await readFile(oldRegistry)).toEqual(oldBytes);
  await expect(new SessionService(store).list()).resolves.toEqual([
    expect.objectContaining({ recordId: 'record-abc' }),
  ]);
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
  const wire = createSessionLifecycleBinding({
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
  const binding: SessionLifecycleBindingRecord = {
    schemaVersion: 2,
    binding: wire,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  };
  await store.saveLifecycleBinding(binding);
  const event = createSessionLifecycleEvent({
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
  const binding = createSessionLifecycleBinding({
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
    schemaVersion: 2,
    binding,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  });
  const event = createSessionLifecycleEvent({
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
  const binding = createSessionLifecycleBinding({
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
    schemaVersion: 2,
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
      createSessionLifecycleEvent({
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
      createSessionLifecycleEvent({
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
      createSessionLifecycleEvent({
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
      createSessionLifecycleEvent({
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
  const wire = createSessionLifecycleBinding({
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
    schemaVersion: 2,
    binding: wire,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  });
  const event = (id: string, nativeId: string, sequence: number) =>
    createSessionLifecycleEvent({
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
  const wire = createSessionLifecycleBinding({
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
    schemaVersion: 2,
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
      createSessionLifecycleEvent({
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
  const wire = createSessionLifecycleBinding({
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
    schemaVersion: 2,
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
      createSessionLifecycleEvent({
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
  const binding = createSessionLifecycleBinding({
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
    schemaVersion: 2,
    binding,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: { kind: 'native-id', value: 'abc' },
    launch,
    location: record().location,
  });
  const resumed = await service.ingest(
    createSessionLifecycleEvent({
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

it('accepts an older event in a new lifecycle without rolling record timestamps backward', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store, () => later);
  await store.saveNativeBinding(nativeBinding());
  await store.put(
    record({
      timestamps: { createdAt: later, updatedAt: later, lastActivityAt: later },
      lifecycle: { bindingId: 'old-binding', sequence: 8, timestamp: later },
    }),
  );
  await store.saveLifecycleBinding({
    ...lifecycleBindingRecord('older-event-binding'),
    nativeSessionRef: { kind: 'native-id', value: 'abc' },
  });
  const ingested = await service.ingest(
    createSessionLifecycleEvent({
      eventId: 'older-new-domain-event',
      bindingId: 'older-event-binding',
      type: 'activity',
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
  );
  expect(ingested.timestamps).toEqual({
    createdAt: later,
    updatedAt: later,
    lastActivityAt: later,
  });
  expect(ingested.lifecycle).toMatchObject({
    bindingId: 'older-event-binding',
    sequence: 1,
    timestamp: instant,
  });
});

it('retains shutdown process evidence for later native activity verification', async () => {
  const store = new SessionStore(await temporary()),
    service = new SessionService(store);
  await store.saveNativeBinding(nativeBinding());
  const binding = createSessionLifecycleBinding({
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
    schemaVersion: 2,
    binding,
    nativeBindingRef: 'native:opaque',
    nativeSessionRef: null,
    launch,
    location: record().location,
  });
  const shutdown = await service.ingest(
    createSessionLifecycleEvent({
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
  const binding = createSessionLifecycleBinding({
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
    schemaVersion: 2,
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
      createSessionLifecycleEvent({
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

it('verifies a native resume seed without persisting successful or failed verification', async () => {
  const store = new SessionStore(await temporary());
  await store.saveNativeBinding(nativeBinding());
  await store.put(record());
  const before = await store.read(identity, 'claude');
  const transaction = vi.spyOn(store, 'transaction');
  const dependencies = {
    resolveConfiguredRoot: async () => ({
      root: 'C:/native',
      canonicalRootDigest: digest,
      identity,
      runtime: 'claude' as const,
    }),
    verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
  };
  const seed = await verifyNativeResumeSeed(store, record(), dependencies);
  expect(seed.launch).toEqual(launch);
  expect(seed).not.toHaveProperty('confirmationDigest');
  for (const target of [
    { valid: false, activity: 'inactive' as const },
    { valid: true, activity: 'active' as const },
    { valid: true, activity: 'unavailable' as const },
  ]) {
    await expect(
      verifyNativeResumeSeed(store, record(), {
        ...dependencies,
        verifyNativeTarget: async () => target,
      }),
    ).rejects.toThrow();
  }
  expect(transaction).not.toHaveBeenCalled();
  expect(await store.read(identity, 'claude')).toEqual(before);
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

it('plans Pi resume from the exact native binding tuple without account authority', async () => {
  const nativeRoot = await temporary();
  await mkdir(path.join(nativeRoot, 'sessions'));
  await writeFile(
    path.join(nativeRoot, 'sessions', 'abc.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'abc', cwd: process.cwd() })}\n`,
  );
  const store = new SessionStore(await temporary()),
    piIdentity = { domain: 'local', name: 'pi' };
  await store.saveNativeBinding(nativeBinding({ runtime: 'pi', identity: piIdentity }));
  const plan = await planResume(
    store,
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:abc',
      identity: piIdentity,
      location: { ...record().location, cwd: process.cwd() },
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/abc.jsonl' },
    }),
    {
      resolveConfiguredRoot: async () => ({
        root: nativeRoot,
        canonicalRootDigest: digest,
        identity: piIdentity,
        runtime: 'pi',
      }),
      verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' }),
    },
  );
  expect(plan.runtime).toBe('pi');
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

it('inventories only MPX-managed records across both runtimes without native discovery adoption', async () => {
  const store = new SessionStore(await temporary());
  await store.put(record({ recordId: 'claude-managed', runtimeQualifiedId: 'claude:managed' }));
  await store.put(
    record({
      recordId: 'pi-managed',
      runtime: 'pi',
      runtimeQualifiedId: 'pi:managed',
      nativeSessionRef: { kind: 'root-relative-file', value: 'managed.jsonl' },
    }),
  );
  await store.put(
    record({
      recordId: 'unbound',
      runtimeQualifiedId: 'claude:unbound',
      launch: null,
      nativeSessionRef: { kind: 'native-id', value: 'unbound' },
    }),
  );

  const inventory = await new SessionService(store).reconcile();

  expect(inventory.records.map((item) => item.recordId)).toEqual(['claude-managed', 'pi-managed']);
  expect(inventory.records.map((item) => item.runtime)).toEqual(['claude', 'pi']);
  expect(inventory.records).not.toContainEqual(expect.objectContaining({ recordId: 'unbound' }));
});

it('scopes inventory and process verification to the selected managed partition', async () => {
  const store = new SessionStore(await temporary());
  const otherIdentity = { domain: identity.domain, name: 'other' };
  for (const [selectedIdentity, runtime, pid] of [
    [identity, 'pi', 42],
    [otherIdentity, 'pi', 43],
    [identity, 'claude', 44],
  ] as const) {
    await store.put(
      record({
        identity: selectedIdentity,
        runtime,
        runtimeQualifiedId: `${runtime}:${pid}`,
        recordId: `record-${pid}`,
        liveness: 'active',
        process: { pid, startFingerprint: 'start' },
      }),
    );
  }
  const inspect = vi.fn(async (pid: number): Promise<ProcessInspection> => ({
    status: 'present',
    pid,
    startFingerprint: 'start',
  }));

  const inventory = await new SessionService(store, () => later, { inspect }).reconcile([], {
    runtime: 'pi',
    identity,
  });

  expect(inventory.records).toMatchObject([
    { runtime: 'pi', runtimeQualifiedId: 'pi:42', liveness: 'active' },
  ]);
  expect(inspect).toHaveBeenCalledExactlyOnceWith(42);
  expect(await new SessionService(store).show('pi:43')).toMatchObject({ liveness: 'active' });
  expect(await new SessionService(store).show('claude:44')).toMatchObject({ liveness: 'active' });
});

it('does not write or advance activity timestamps when verified inventory is unchanged', async () => {
  const store = new SessionStore(await temporary());
  const unchanged = record({
    runtime: 'pi',
    runtimeQualifiedId: 'pi:unchanged',
    recordId: 'unchanged',
    liveness: 'active',
    process: { pid: 42, startFingerprint: 'start' },
  });
  await store.put(unchanged);
  const transaction = vi.spyOn(store, 'transaction');

  const inventory = await new SessionService(store, () => later, {
    inspect: async (pid) => ({ status: 'present', pid, startFingerprint: 'start' }),
  }).reconcile();

  expect(inventory.records).toEqual([unchanged]);
  expect(transaction).not.toHaveBeenCalled();
  expect((await store.read(identity, 'pi')).records[0]?.timestamps).toEqual(unchanged.timestamps);
});

it('keeps valid account inventory when another account partition is corrupt', async () => {
  const root = await temporary();
  const store = new SessionStore(root);
  await store.put(record({ recordId: 'valid', runtimeQualifiedId: 'claude:valid' }));
  const corruptIdentity = { domain: 'work', name: 'corrupt' };
  const corruptPath = store.registryPath(corruptIdentity, 'claude');
  await mkdir(path.dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, '{not-json');

  const inventory = await new SessionService(store).reconcile();

  expect(inventory.records.map((item) => item.recordId)).toEqual(['valid']);
  expect(inventory.diagnostics).toContainEqual({
    runtime: 'claude',
    identity: corruptIdentity,
    status: 'unknown',
    code: 'SESSION_PARTITION_UNREADABLE',
  });
});

it('finds an exact managed record despite an unreadable unrelated account partition', async () => {
  const root = await temporary();
  const store = new SessionStore(root);
  await store.put(record({ recordId: 'selected-record' }));
  const corruptPath = store.registryPath({ domain: 'work', name: 'corrupt' }, 'claude');
  await mkdir(path.dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, '{not-json');

  await expect(new SessionService(store).show('selected-record')).resolves.toMatchObject({
    recordId: 'selected-record',
    identity,
  });
});

it('processes only the selected record during record-scoped reconciliation', async () => {
  const store = new SessionStore(await temporary());
  await store.put(
    record({
      recordId: 'selected',
      runtimeQualifiedId: 'claude:selected',
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'selected-start' },
    }),
  );
  const excluded = record({
    recordId: 'excluded',
    runtimeQualifiedId: 'claude:excluded',
    liveness: 'active',
    process: { pid: 43, startFingerprint: 'excluded-start' },
  });
  await store.put(excluded);
  const inspect = vi.fn(async (): Promise<ProcessInspection> => ({ status: 'absent' }));

  const inventory = await new SessionService(store, () => later, { inspect }).reconcile([], {
    identity,
    runtime: 'claude',
    recordId: 'selected',
  });

  expect(inspect).toHaveBeenCalledExactlyOnceWith(42);
  expect(inventory.records).toMatchObject([{ recordId: 'selected', liveness: 'inactive' }]);
  expect((await store.read(identity, 'claude')).records).toContainEqual(excluded);
});

it('reads only the selected identity and runtime during scoped reconciliation', async () => {
  const store = new SessionStore(await temporary());
  const otherIdentity = { domain: 'work', name: 'other' };
  await store.put(record({ runtime: 'pi', runtimeQualifiedId: 'pi:selected' }));
  await store.put(
    record({
      identity: otherIdentity,
      runtime: 'claude',
      runtimeQualifiedId: 'claude:other',
      recordId: 'other',
    }),
  );
  const read = vi.spyOn(store, 'read');

  await new SessionService(store).reconcile([], { identity, runtime: 'pi' });

  expect(read).toHaveBeenCalledExactlyOnceWith(identity, 'pi');
});

it('fails closed for a shorthand lookup when any partition is unreadable', async () => {
  const root = await temporary();
  const store = new SessionStore(root);
  await store.put(record({ recordId: 'selected-record' }));
  const corruptPath = store.registryPath({ domain: 'work', name: 'corrupt' }, 'claude');
  await mkdir(path.dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, '{not-json');

  await expect(new SessionService(store).show('selected')).rejects.toMatchObject({
    code: 'SESSION_AMBIGUOUS',
  });
});

it.each(['claude', 'pi'] as const)(
  'verifies an exact managed %s process from the fresh inspection snapshot',
  async (runtime) => {
    const store = new SessionStore(await temporary());
    await store.put(
      record({
        runtime,
        runtimeQualifiedId: `${runtime}:exact`,
        recordId: `${runtime}-exact`,
        liveness: 'unknown',
        process: { pid: 42, startFingerprint: 'start' },
      }),
    );

    const inventory = await new SessionService(store, () => later, {
      inspect: async (pid) => ({ status: 'present', pid, startFingerprint: 'start' }),
    }).reconcile();

    expect(inventory.records).toMatchObject([{ runtime, liveness: 'active' }]);
  },
);

it.each(['claude', 'pi'] as const)(
  'marks managed %s liveness unknown when no process inspector is available',
  async (runtime) => {
    const store = new SessionStore(await temporary());
    await store.put(
      record({
        runtime,
        runtimeQualifiedId: `${runtime}:uninspected`,
        recordId: `${runtime}-uninspected`,
        liveness: 'active',
        process: { pid: 42, startFingerprint: 'start' },
      }),
    );

    const inventory = await new SessionService(store, () => later).reconcile();

    expect(inventory.records).toMatchObject([
      {
        runtime,
        liveness: 'unknown',
        process: { pid: 42, startFingerprint: 'start' },
      },
    ]);
  },
);

it('batches unique eligible Pi PIDs across partitions once per fresh reconcile without losing tuple checks', async () => {
  const store = new SessionStore(await temporary());
  const states = [
    { id: 'exact', pid: 42, startFingerprint: 'start', expected: 'active' },
    { id: 'reused', pid: 42, startFingerprint: 'old', expected: 'unknown' },
    { id: 'absent', pid: 43, startFingerprint: 'start', expected: 'inactive' },
    { id: 'unknown', pid: 44, startFingerprint: 'start', expected: 'unknown' },
  ] as const;
  for (const state of states) {
    await store.put(
      record({
        identity: { domain: 'personal', name: state.id },
        runtime: 'pi',
        runtimeQualifiedId: `pi:${state.id}`,
        recordId: state.id,
        liveness: 'active',
        process: { pid: state.pid, startFingerprint: state.startFingerprint },
      }),
    );
  }
  await store.put(
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:inactive',
      recordId: 'inactive',
      liveness: 'inactive',
      process: { pid: 45, startFingerprint: 'start' },
    }),
  );
  const inspect = vi.fn();
  const inspectMany = vi.fn(
    async (_pids: readonly number[]): Promise<ReadonlyMap<number, ProcessInspection>> =>
      new Map([
        [42, { status: 'present', pid: 42, startFingerprint: 'start' }],
        [43, { status: 'absent' }],
        [44, { status: 'unknown' }],
      ]),
  );
  const service = new SessionService(store, () => later, { inspect, inspectMany });
  await service.reconcile([]);
  expect(inspect).not.toHaveBeenCalled();
  expect(inspectMany).toHaveBeenCalledTimes(1);
  expect([...inspectMany.mock.calls[0]![0]].sort()).toEqual([42, 43, 44]);
  for (const state of states) {
    expect(await service.show(`pi:${state.id}`)).toMatchObject({
      liveness: state.expected,
      process:
        state.expected === 'inactive'
          ? null
          : { pid: state.pid, startFingerprint: state.startFingerprint },
    });
  }
  await service.reconcile([]);
  expect(inspectMany).toHaveBeenCalledTimes(2);
  expect([...inspectMany.mock.calls[1]![0]].sort()).toEqual([42, 44]);
});

it('bounds fallback concurrency and probes repeated PIDs only once per reconcile', async () => {
  const store = new SessionStore(await temporary());
  for (let index = 0; index < 20; index++) {
    await store.put(
      record({
        runtime: 'pi',
        runtimeQualifiedId: `pi:${index}`,
        recordId: `record-${index}`,
        liveness: 'active',
        process: { pid: 42 + (index % 10), startFingerprint: 'start' },
      }),
    );
  }
  let running = 0,
    maximum = 0;
  const inspect = vi.fn(async (pid: number): Promise<ProcessInspection> => {
    running++;
    maximum = Math.max(maximum, running);
    await new Promise<void>((resolve) => setImmediate(resolve));
    running--;
    return { status: 'present', pid, startFingerprint: 'start' };
  });
  const service = new SessionService(store, () => later, { inspect });
  await service.reconcile([]);
  expect(inspect).toHaveBeenCalledTimes(10);
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(8);
  await service.reconcile([]);
  expect(inspect).toHaveBeenCalledTimes(20);
});

it('treats failed or incomplete batch inspection as unknown rather than absence', async () => {
  const store = new SessionStore(await temporary());
  await store.put(
    record({
      runtime: 'pi',
      runtimeQualifiedId: 'pi:failed',
      recordId: 'failed',
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
    }),
  );
  const inspectMany = vi
    .fn()
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValueOnce(new Map());
  const service = new SessionService(store, () => later, { inspect: vi.fn(), inspectMany });
  for (let index = 0; index < 2; index++) {
    await service.reconcile([]);
    expect(await service.show('pi:failed')).toMatchObject({
      liveness: 'unknown',
      process: { pid: 42, startFingerprint: 'start' },
    });
  }
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
  const inventory = await new SessionService(store, () => later, {
    inspect: async (pid) => ({ status: 'present', pid, startFingerprint: 'start' }),
  }).reconcile([]);
  expect(inventory.records[0]).toMatchObject({
    liveness: 'active',
    process: { pid: 42 },
    timestamps: { updatedAt: instant, lastActivityAt: instant },
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

it('does not roll a Pi record timestamp backward after a concurrent update', async () => {
  const store = new SessionStore(await temporary());
  const original = record({
    runtime: 'pi',
    runtimeQualifiedId: 'pi:timestamp-race',
    recordId: 'pi-timestamp-race',
    identity: { domain: 'local', name: 'pi' },
    nativeSessionRef: { kind: 'root-relative-file', value: 'timestamp-race.jsonl' },
    liveness: 'active',
    process: { pid: 42, startFingerprint: 'start' },
  });
  await store.put(original);
  let inspected!: () => void, release!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  const continueInspection = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconciling = new SessionService(store, () => instant, {
    inspect: async () => {
      inspected();
      await continueInspection;
      return { status: 'absent' };
    },
  }).reconcile([]);
  await inspectionStarted;
  await store.put({
    ...original,
    timestamps: { ...original.timestamps, createdAt: later, updatedAt: later },
  });
  release();
  await reconciling;
  expect(await new SessionService(store).show('pi:timestamp-race')).toMatchObject({
    liveness: 'inactive',
    process: null,
    timestamps: { createdAt: later, updatedAt: later },
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
  const inventory = await service.reconcile([]);
  expect(inventory.records[0]).toMatchObject({
    liveness: 'inactive',
    process: null,
    timestamps: { updatedAt: later, lastActivityAt: instant },
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
  const inventory = await service.reconcile([]);
  expect(inventory.records[0]).toMatchObject({
    liveness: 'unknown',
    process: { pid: 42, startFingerprint: 'start' },
    timestamps: { updatedAt: later, lastActivityAt: instant },
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
  const inventory = await service.reconcile([]);
  expect(inventory.records[0]).toMatchObject({
    liveness: 'unknown',
    process: { pid: 42, startFingerprint: 'start' },
    timestamps: { updatedAt: later, lastActivityAt: instant },
  });
});
