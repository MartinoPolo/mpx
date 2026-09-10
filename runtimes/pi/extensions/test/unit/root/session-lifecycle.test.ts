import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ProductionSessionLifecycleBridge } from '@mpx/application/node';
import { parseSessionLifecycleEvent, type RuntimeContext } from '@mpx/runtime-contracts';
import { LifecycleEventDirectoryConsumer, SessionService, SessionStore } from '@mpx/sessions';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import mpxPiExtensions, { DEFAULT_EXTENSION_COMPONENTS } from '../../../index.js';
import sessionLifecycle from '../../../session-lifecycle.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>();
  return { ...filesystem, link: vi.fn(filesystem.link) };
});

const { link: originalLink } =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const temporaryRoots: string[] = [];
const fingerprint = '2025-01-02T03:04:05.000Z';
const MANAGED_DISCOVERY_ENVIRONMENT = [
  'MPX_RUNTIME',
  'MPX_RUNTIME_CONTEXT',
  'MPX_ACTIVE_CONTENT_ROOT',
  'MPX_ACTIVE_CONTENT_MANIFEST',
  'MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY',
  'MPX_COMPILED_AGENTS_DIR',
  'MPX_RUNTIME_PROJECTION_REFERENCE',
  'MPX_IDENTITY',
  'MPX_MODE',
] as const;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(link).mockReset().mockImplementation(originalLink);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;

function harness(manager: SessionManager) {
  const handlers = new Map<string, Handler[]>();
  const notify = vi.fn();
  let title: string | undefined = 'Initial title';
  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    exec: vi.fn(async () => ({ stdout: `${fingerprint}\n`, stderr: '', code: 0, killed: false })),
    getSessionName: () => title,
    events: { on: () => () => {}, emit: () => {} },
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  const context = {
    cwd: manager.getCwd(),
    sessionManager: manager,
    thinkingLevel: 'high',
    model: { provider: 'provider', id: 'initial-model' },
    hasUI: true,
    ui: { notify },
  } as unknown as ExtensionContext;
  return {
    api,
    context,
    notify,
    handlers,
    rename: (value: string | undefined) => {
      title = value;
    },
    emit: async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, context);
      }
    },
  };
}

async function fixture(identity = { domain: 'personal', name: 'prejemesi' }) {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-lifecycle-producer-'));
  temporaryRoots.push(root);
  const cwd = path.join(root, 'repository');
  const nativeRoot = path.join(root, 'native');
  await Promise.all([mkdir(cwd), mkdir(nativeRoot)]);
  const store = new SessionStore(path.join(root, 'state'));
  const bridge = new ProductionSessionLifecycleBridge({ store });
  const runtimeContext: RuntimeContext = {
    schemaVersion: 2,
    launchKey: 'launch',
    launchDescriptor: { reference: 'launch.json', digest: 'a'.repeat(64) },
    manifestKey: 'manifest',
    runtimeArtifact: {
      schemaVersion: 5,
      runtime: 'pi',
      manifestKey: 'manifest',
      artifactKey: 'artifact',
      fileMapHash: 'b'.repeat(64),
    },
    binding: {
      projectId: 'project',
      repositoryId: 'repository',
      identity: identity.name,
      selection: {
        location: { name: 'fixture', canonicalRoot: cwd },
        packs: ['development'],
        source: 'user-location',
      },
    },
  };
  const prepared = await bridge.prepare({
    descriptor: {
      schemaVersion: 3,
      nativeRuntimeRootDigest: 'c'.repeat(64),
      runtime: 'pi',
      identity,
      launchKey: runtimeContext.launchKey,
      binding: { projectId: 'project', repositoryId: 'repository' },
      mode: 'project',
      selection: runtimeContext.binding.selection,
      executor: {
        name: 'host',
        effectiveEnforcement: 'advisory',
        isolation: 'none',
        interception: {
          kind: 'policy-hooks',
          intercepted: ['mpx-mediated-operations'],
          knownBypasses: ['raw-shell', 'direct-filesystem', 'unmanaged-children'],
        },
        mounts: { kind: 'host-direct', policyEnforced: false },
        confidentiality: {
          isolated: false,
          hostReadable: true,
          limitation: 'No filesystem or confidentiality isolation is enforced.',
        },
      },
      workspace: 'direct',
      networkPolicy: { name: 'minimal', declaration: { preset: 'deny-all' } },
      preset: null,
      provenance: {
        runtime: 'explicit',
        identity: 'explicit',
        mode: 'explicit',
        executor: 'explicit',
        workspace: 'explicit',
        networkPolicy: 'explicit',
      },
      diagnostics: [],
      cwdClassification: { domain: identity.domain, location: 'fixture' },
      routes: {
        gitAuthor: `git-${identity.name}`,
        providers: {},
        ssh: null,
        mcp: { allow: [], shareNativeAuth: false },
      },
      intendedPolicy: {
        mode: 'project',
        resources: { 'selected-project': 'read-write' },
        inputsDigest: 'e'.repeat(64),
      },
      skillArtifact: {
        schemaVersion: 4,
        runtime: 'pi',
        identity: identity.name,
        projectId: runtimeContext.binding.projectId,
        repositoryId: runtimeContext.binding.repositoryId,
        catalogHash: '1'.repeat(64),
        location: runtimeContext.binding.selection.location,
        packs: runtimeContext.binding.selection.packs,
        selectionSource: runtimeContext.binding.selection.source,
        selectionHash: '2'.repeat(64),
        artifactKey: runtimeContext.runtimeArtifact.artifactKey,
      },
      elevationAudit: {
        elevated: true,
        reason: 'fixture',
        approvalsDigest: 'f'.repeat(64),
        banner: {
          code: 'ELEVATED_LAUNCH',
          persistent: true,
          message: 'ELEVATED LAUNCH — fixture',
        },
      },
    },
    runtimeContext,
    nativeRuntimeRoot: nativeRoot,
    cwd,
  });
  const manager = SessionManager.create(cwd, path.join(nativeRoot, 'sessions', 'project'));
  const environment = {
    MPX_RUNTIME: 'pi',
    MPX_RUNTIME_CONTEXT: JSON.stringify(runtimeContext),
    PI_CODING_AGENT_DIR: nativeRoot,
    MPX_SESSION_LIFECYCLE_BINDING_ID: prepared.binding.bindingId,
    MPX_SESSION_LIFECYCLE_EVENT_DIR: prepared.eventDirectory,
  };
  const extension = harness(manager);
  const events = async () =>
    Promise.all(
      (await readdir(prepared.eventDirectory))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map(async (name) =>
          parseSessionLifecycleEvent(
            JSON.parse(await readFile(path.join(prepared.eventDirectory, name), 'utf8')),
          ),
        ),
    );
  const persist = () =>
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Fixture response' }],
      api: 'openai-responses',
      provider: 'provider',
      model: 'initial-model',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
  return {
    root,
    store,
    bridge,
    prepared,
    manager,
    environment,
    extension,
    events,
    persist,
    identity,
  };
}

it('rejects the obsolete v1 session-store path without a legacy fallback', async () => {
  const { extension, environment, prepared } = await fixture();
  const sessionsDirectory = path.dirname(
    path.dirname(path.dirname(path.dirname(prepared.eventDirectory))),
  );
  const legacyDirectory = path.join(
    sessionsDirectory,
    'v1',
    'private',
    'lifecycle-events',
    path.basename(prepared.eventDirectory),
  );
  sessionLifecycle(extension.api, {
    ...environment,
    MPX_SESSION_LIFECYCLE_EVENT_DIR: legacyDirectory,
  });
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /private session store path/,
  );
  expect(extension.api.exec).not.toHaveBeenCalled();
});

it.each([
  { domain: 'personal', name: 'prejemesi' },
  { domain: 'work', name: 'work' },
])(
  'round-trips the real producer into a durable launch-bound record for $domain:$name',
  async (identity) => {
    const fixtureValue = await fixture(identity);
    const { extension, environment, manager, prepared, store, events } = fixtureValue;
    fixtureValue.persist();
    sessionLifecycle(extension.api, environment);
    await extension.emit('session_start', { reason: 'startup' });
    expect(await events()).toMatchObject([
      {
        type: 'start',
        sequence: 1,
        nativeSessionId: manager.getSessionId(),
        nativeSessionRef: {
          kind: 'root-relative-file',
          value: `sessions/project/${path.basename(manager.getSessionFile()!)}`,
        },
        pid: process.pid,
        startFingerprint: fingerprint,
      },
    ]);
    const consumer = new LifecycleEventDirectoryConsumer(store, new SessionService(store));
    expect(await consumer.consume(prepared.binding.bindingId)).toBe(1);
    extension.rename('Updated title');
    Object.assign(extension.context, {
      model: { provider: 'provider', id: 'next-model' },
      thinkingLevel: 'medium',
    });
    await Promise.all([
      extension.emit('session_info_changed', { name: 'Updated title' }),
      extension.emit('model_select'),
      extension.emit('thinking_level_select'),
      extension.emit('agent_start'),
      extension.emit('turn_end'),
      extension.emit('agent_settled'),
      extension.emit('session_shutdown', { reason: 'quit' }),
    ]);
    const pending = await events();
    expect(pending.map((event) => event.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(pending.at(-1)?.type).toBe('shutdown');
    expect(
      pending.every((event) => event.model === 'provider/next-model' && event.effort === 'medium'),
    ).toBe(true);
    expect(await consumer.consume(prepared.binding.bindingId)).toBe(7);
    await extension.emit('session_shutdown', { reason: 'quit' });
    expect(await events()).toEqual([]);
    const records = await new SessionService(store).list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      identity,
      runtimeQualifiedId: `pi:${manager.getSessionId()}`,
      liveness: 'inactive',
      launch: { launchKey: 'launch' },
      metadata: { title: 'Updated title', model: 'provider/next-model', effort: 'medium' },
      lifecycle: { bindingId: prepared.binding.bindingId, sequence: 8 },
    });
    expect(extension.api.exec).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([expect.stringContaining(`ProcessId = ${process.pid}`)]),
      { timeout: 5_000 },
    );
  },
);

it('retains startup events until Pi persists its real header, then shutdown drains the queue', async () => {
  const { extension, environment, manager, events, persist, store, prepared, identity } =
    await fixture();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  await extension.emit('agent_start');
  await expect(readFile(manager.getSessionFile()!, 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const consumer = new LifecycleEventDirectoryConsumer(store, new SessionService(store));
  expect(await events()).toEqual([]);
  expect(await consumer.consume(prepared.binding.bindingId)).toBe(0);
  const beforePersistence = Date.now();
  persist();
  await extension.emit('session_shutdown', { reason: 'quit' });
  const pending = await events();
  expect(pending.map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'activity'],
    [3, 'shutdown'],
  ]);
  expect(Date.parse(pending[0]!.timestamp)).toBeLessThanOrEqual(beforePersistence);
  expect(pending.every(({ nativeSessionId }) => nativeSessionId === manager.getSessionId())).toBe(
    true,
  );
  expect(await consumer.consume(prepared.binding.bindingId)).toBe(3);
  expect((await store.read(identity, 'pi')).recentEventIds).toContain(pending[0]!.eventId);
  expect(await new SessionService(store).list()).toMatchObject([
    {
      runtimeQualifiedId: `pi:${manager.getSessionId()}`,
      lifecycle: { bindingId: prepared.binding.bindingId, sequence: 3 },
      timestamps: { createdAt: pending[0]!.timestamp },
      liveness: 'inactive',
    },
  ]);
});

it('native-only sessions register no producer hooks and create no events', async () => {
  const { extension, events } = await fixture();
  sessionLifecycle(extension.api, { PI_SESSION_ID: 'native', PI_SESSION_FILE: 'native.jsonl' });
  expect(extension.handlers.size).toBe(0);
  await extension.emit('session_start', { reason: 'startup' });
  expect(await events()).toEqual([]);
});

it.each([
  ['missing binding', { MPX_SESSION_LIFECYCLE_BINDING_ID: undefined }],
  ['missing directory', { MPX_SESSION_LIFECYCLE_EVENT_DIR: undefined }],
  ['blank binding', { MPX_SESSION_LIFECYCLE_BINDING_ID: '' }],
  ['traversal binding', { MPX_SESSION_LIFECYCLE_BINDING_ID: '../escape' }],
  ['wrong runtime', { MPX_RUNTIME: 'claude' }],
  ['missing context', { MPX_RUNTIME_CONTEXT: undefined }],
  ['malformed context', { MPX_RUNTIME_CONTEXT: '{' }],
  ['relative native root', { PI_CODING_AGENT_DIR: 'native' }],
] as const)('rejects %s visibly without writing events', async (_label, overrides) => {
  const { extension, environment, events } = await fixture();
  sessionLifecycle(extension.api, { ...environment, ...overrides });
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow();
  expect(await events()).toEqual([]);
  expect(extension.api.exec).not.toHaveBeenCalled();
});

it('rejects arbitrary directories, mismatched project contexts, and changed working directories', async () => {
  const { extension, environment, root, events } = await fixture();
  sessionLifecycle(extension.api, { ...environment, MPX_SESSION_LIFECYCLE_EVENT_DIR: root });
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /private session store path/,
  );
  expect(await events()).toEqual([]);
  const second = await fixture();
  const context = JSON.parse(second.environment.MPX_RUNTIME_CONTEXT);
  context.binding.projectId = 'another-project';
  sessionLifecycle(second.extension.api, {
    ...second.environment,
    MPX_RUNTIME_CONTEXT: JSON.stringify(context),
  });
  await expect(second.extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /project/,
  );
  const third = await fixture();
  Object.assign(third.extension.context, { cwd: root });
  sessionLifecycle(third.extension.api, third.environment);
  await expect(third.extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /working directory/,
  );
});

it('rejects an event-directory ancestor link without writing into the target', async () => {
  const { extension, environment, prepared, root } = await fixture();
  const directory = path.dirname(prepared.eventDirectory);
  const target = path.join(root, 'relocated-events');
  await rename(directory, target);
  await symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
  sessionLifecycle(extension.api, environment);
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(/link/);
  expect(await readdir(path.join(target, path.basename(prepared.eventDirectory)))).toEqual([]);
});

it('continues the original durable record monotonically across same-session reload', async () => {
  const { extension, manager, environment, events, persist, store, prepared } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  const service = new SessionService(store);
  const consumer = new LifecycleEventDirectoryConsumer(store, service);
  await consumer.consume(prepared.binding.bindingId);
  const original = (await service.list())[0]!;
  await extension.emit('session_shutdown', { reason: 'reload' });
  const reloaded = harness(manager);
  sessionLifecycle(reloaded.api, environment);
  await reloaded.emit('session_start', { reason: 'reload' });
  await reloaded.emit('agent_start');
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([
    [2, 'shutdown'],
    [3, 'start'],
    [4, 'activity'],
  ]);
  await consumer.consume(prepared.binding.bindingId);
  expect(await service.list()).toMatchObject([
    {
      recordId: original.recordId,
      timestamps: { createdAt: original.timestamps.createdAt },
      lifecycle: { bindingId: prepared.binding.bindingId, sequence: 4 },
      liveness: 'active',
    },
  ]);
  expect(reloaded.notify).not.toHaveBeenCalled();
  expect(reloaded.api.exec).not.toHaveBeenCalled();
});

it.each(['new', 'resume', 'fork'] as const)(
  'allows native %s, drains the original snapshot, and makes no replacement claim',
  async (reason) => {
    const { extension, manager, environment, events, persist, store, prepared, root } =
      await fixture();
    persist();
    sessionLifecycle(extension.api, environment);
    await extension.emit('session_start', { reason: 'startup' });
    const originalId = manager.getSessionId();
    const originalFile = manager.getSessionFile()!;
    const receipt = await readFile(path.join(prepared.eventDirectory, '.writer'), 'utf8');
    expect(extension.handlers.has('session_before_switch')).toBe(false);
    expect(extension.handlers.has('session_before_fork')).toBe(false);
    await extension.emit(reason === 'fork' ? 'session_before_fork' : 'session_before_switch', {
      reason,
    });
    const queued = extension.emit('agent_start');
    // Model the mutable-manager boundary during native replacement teardown.
    if (reason === 'new') {
      manager.newSession();
    } else if (reason === 'resume') {
      const target = SessionManager.create(manager.getCwd(), path.join(root, 'another-root'));
      manager.setSessionFile(target.getSessionFile()!);
    } else {
      manager.createBranchedSession(manager.getLeafId()!);
    }
    await extension.emit('session_shutdown', { reason });
    await queued;
    const replacement = harness(manager);
    sessionLifecycle(replacement.api, environment);
    await replacement.emit('session_start', { reason, previousSessionFile: originalFile });
    for (const hook of [
      'agent_start',
      'session_info_changed',
      'model_select',
      'session_shutdown',
    ]) {
      await replacement.emit(hook);
      await extension.emit(hook);
    }
    const reloaded = harness(manager);
    sessionLifecycle(reloaded.api, environment);
    await reloaded.emit('session_start', { reason: 'reload' });
    await reloaded.emit('agent_start');
    expect(
      (await events()).map(({ sequence, type, nativeSessionId }) => [
        sequence,
        type,
        nativeSessionId,
      ]),
    ).toEqual([
      [1, 'start', originalId],
      [2, 'activity', originalId],
      [3, 'shutdown', originalId],
    ]);
    expect(await readFile(path.join(prepared.eventDirectory, '.writer'), 'utf8')).toBe(receipt);
    expect(replacement.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('not MPX launch-bound'),
      'warning',
    );
    expect(reloaded.notify).not.toHaveBeenCalled();
    expect(replacement.api.exec).not.toHaveBeenCalled();
    const service = new SessionService(store);
    await new LifecycleEventDirectoryConsumer(store, service).consume(prepared.binding.bindingId);
    expect(await service.list()).toMatchObject([
      { runtimeQualifiedId: `pi:${originalId}`, liveness: 'inactive', lifecycle: { sequence: 3 } },
    ]);
  },
);

it('keeps tracking the original when another extension cancels a native replacement', async () => {
  const { extension, environment, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  const cancel = vi.fn(() => ({ cancel: true }));
  extension.handlers.set('session_before_switch', [cancel]);
  await extension.emit('session_before_switch', { reason: 'new' });
  await extension.emit('agent_start');
  expect(cancel).toHaveReturnedWith({ cancel: true });
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'activity'],
  ]);
  expect(extension.notify).not.toHaveBeenCalled();
});

it('refuses duplicate writers and never promotes a partial crash file to an event', async () => {
  const { extension, manager, environment, prepared, store, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  const duplicate = harness(manager);
  sessionLifecycle(duplicate.api, environment);
  await expect(duplicate.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /already has/,
  );
  await writeFile(path.join(prepared.eventDirectory, '0000000000000002-crashed.json.tmp'), '{');
  const consumer = new LifecycleEventDirectoryConsumer(store, new SessionService(store));
  expect(await consumer.consume(prepared.binding.bindingId)).toBe(1);
  expect(await events()).toEqual([]);
  expect(
    await readFile(path.join(prepared.eventDirectory, '0000000000000002-crashed.json.tmp'), 'utf8'),
  ).toBe('{');
});

it('preserves unpublished events across reload without backfilling their timestamps', async () => {
  const { extension, environment, manager, events, persist } = await fixture();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  await extension.emit('session_shutdown', { reason: 'reload' });
  const beforeReload = Date.now();
  const reloaded = harness(manager);
  sessionLifecycle(reloaded.api, environment);
  await reloaded.emit('session_start', { reason: 'reload' });
  expect(await events()).toEqual([]);
  persist();
  await reloaded.emit('agent_start');
  const pending = await events();
  expect(pending.map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'shutdown'],
    [3, 'start'],
    [4, 'activity'],
  ]);
  expect(Date.parse(pending[0]!.timestamp)).toBeLessThanOrEqual(beforeReload);
  expect(Date.parse(pending[1]!.timestamp)).toBeLessThanOrEqual(beforeReload);
});

it.each(['malformed', 'wrong-id', 'wrong-cwd', 'wrong-version'] as const)(
  'does not publish deferred events for an existing %s native header',
  async (kind) => {
    const { extension, environment, manager, events } = await fixture();
    sessionLifecycle(extension.api, environment);
    await extension.emit('session_start', { reason: 'startup' });
    const header = {
      ...manager.getHeader(),
      ...(kind === 'wrong-id' ? { id: 'another-session' } : {}),
      ...(kind === 'wrong-cwd' ? { cwd: path.dirname(manager.getCwd()) } : {}),
      ...(kind === 'wrong-version' ? { version: 999 } : {}),
    };
    await writeFile(
      manager.getSessionFile()!,
      kind === 'malformed' ? '{\n' : `${JSON.stringify(header)}\n`,
    );
    await expect(extension.emit('agent_start')).rejects.toThrow();
    expect(await events()).toEqual([]);
  },
);

it('rejects an injected native root even when its native file has the same relative path', async () => {
  const { extension, environment, manager, root, events } = await fixture();
  const substitute = path.join(root, 'substitute');
  const relative = path.relative(environment.PI_CODING_AGENT_DIR, manager.getSessionFile()!);
  await mkdir(path.dirname(path.join(substitute, relative)), { recursive: true });
  manager.setSessionFile(path.join(substitute, relative));
  sessionLifecycle(extension.api, { ...environment, PI_CODING_AGENT_DIR: substitute });
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /private launch binding/,
  );
  expect(await events()).toEqual([]);
});

it('fails closed rather than deferring through a linked native session directory', async () => {
  const { extension, environment, manager, root, events } = await fixture();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  const directory = path.dirname(manager.getSessionFile()!);
  const target = path.join(root, 'relocated-native-sessions');
  await rename(directory, target);
  await symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(extension.emit('agent_start')).rejects.toThrow(/link/);
  expect(await events()).toEqual([]);
});

it('uses the native manager rather than injected session identity or sequence fields', async () => {
  const { extension, environment, manager, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, {
    ...environment,
    PI_SESSION_ID: 'substitute',
    PI_SESSION_FILE: 'substitute.jsonl',
    MPX_SESSION_LIFECYCLE_SEQUENCE: '900',
    MPX_SESSION_LIFECYCLE_START_FINGERPRINT: 'substitute',
  });
  await extension.emit('session_start', { reason: 'startup' });
  expect(await events()).toMatchObject([
    { sequence: 1, nativeSessionId: manager.getSessionId(), startFingerprint: fingerprint },
  ]);
});

it('rejects native session files outside the configured Pi directory', async () => {
  const { extension, manager, environment, root, events } = await fixture();
  manager.setSessionFile(path.join(root, 'outside.jsonl'));
  sessionLifecycle(extension.api, environment);
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /root-relative/,
  );
  expect(await events()).toEqual([]);
});

it('does not acquire a binding with an existing or crash-partial writer receipt', async () => {
  const { extension, environment, prepared, events } = await fixture();
  await writeFile(path.join(prepared.eventDirectory, '.writer'), '{', { flag: 'wx' });
  sessionLifecycle(extension.api, environment);
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(await events()).toEqual([]);
  expect(await readFile(path.join(prepared.eventDirectory, '.writer'), 'utf8')).toBe('{');
});

it('bounds event metadata before publishing any JSON event', async () => {
  const { extension, environment, events } = await fixture();
  extension.rename('x'.repeat(513));
  sessionLifecycle(extension.api, environment);
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(/title/);
  expect(await events()).toEqual([]);
});

it('retries failed publication in order without losing or duplicating events', async () => {
  const { extension, environment, events, persist, store, prepared } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  vi.mocked(link).mockRejectedValueOnce(new Error('transient publication failure'));
  extension.rename('Retained pending title');
  await expect(extension.emit('session_info_changed')).rejects.toThrow(/transient/);
  expect((await events()).map(({ sequence }) => sequence)).toEqual([1]);
  extension.rename('Recovered title');
  await extension.emit('agent_start');
  await extension.emit('session_shutdown');
  await extension.emit('session_shutdown');
  const pending = await events();
  expect(pending.map(({ sequence, type, title }) => [sequence, type, title])).toEqual([
    [1, 'start', 'Initial title'],
    [2, 'info', 'Retained pending title'],
    [3, 'activity', 'Recovered title'],
    [4, 'shutdown', 'Recovered title'],
  ]);
  expect(new Set(pending.map(({ eventId }) => eventId)).size).toBe(pending.length);
  const consumer = new LifecycleEventDirectoryConsumer(store, new SessionService(store));
  expect(await consumer.consume(prepared.binding.bindingId)).toBe(4);
  expect(await consumer.consume(prepared.binding.bindingId)).toBe(0);
});

it('drains a failed startup publication on shutdown and continues after reload', async () => {
  const { extension, environment, manager, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  vi.mocked(link).mockRejectedValueOnce(new Error('transient publication failure'));
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(/transient/);
  await extension.emit('session_shutdown', { reason: 'reload' });
  const reloaded = harness(manager);
  sessionLifecycle(reloaded.api, environment);
  await reloaded.emit('session_start', { reason: 'reload' });
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'shutdown'],
    [3, 'start'],
  ]);
});

it('does not republish an already drained prefix after a later publication failure', async () => {
  const { extension, environment, manager, events, persist } = await fixture();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  await extension.emit('agent_start');
  persist();
  vi.mocked(link)
    .mockImplementationOnce(originalLink)
    .mockRejectedValueOnce(new Error('second publication failed'));
  await expect(extension.emit('session_shutdown', { reason: 'reload' })).rejects.toThrow(/second/);
  const first = (await events())[0]!;
  expect((await events()).map(({ sequence }) => sequence)).toEqual([1]);
  const reloaded = harness(manager);
  sessionLifecycle(reloaded.api, environment);
  await reloaded.emit('session_start', { reason: 'reload' });
  const pending = await events();
  expect(pending.map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'activity'],
    [3, 'shutdown'],
    [4, 'start'],
  ]);
  expect(pending[0]).toEqual(first);
  expect(new Set(pending.map(({ eventId }) => eventId)).size).toBe(pending.length);
});

it.each([
  ['title', 512],
  ['model', 128],
  ['effort', 128],
] as const)('retains the last valid snapshot after an oversized %s', async (field, bound) => {
  const { extension, environment, events, persist } = await fixture();
  persist();
  extension.rename('t'.repeat(512));
  Object.assign(extension.context, {
    model: { provider: 'p', id: 'm'.repeat(126) },
    thinkingLevel: 'e'.repeat(128),
  });
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  if (field === 'title') {
    extension.rename('x'.repeat(bound + 1));
  } else if (field === 'model') {
    Object.assign(extension.context, { model: { provider: 'p', id: 'm'.repeat(bound) } });
  } else {
    Object.assign(extension.context, { thinkingLevel: 'e'.repeat(bound + 1) });
  }
  await expect(extension.emit('session_info_changed')).rejects.toThrow(field);
  await extension.emit('session_shutdown');
  const pending = await events();
  expect(pending.map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'shutdown'],
  ]);
  expect(
    pending.every(
      ({ title, model, effort }) =>
        title?.length === 512 && model?.length === 128 && effort?.length === 128,
    ),
  ).toBe(true);
});

it('does not recover a rejected foreign native reference into the publication queue', async () => {
  const { extension, environment, manager, root, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  const nativeFile = vi.spyOn(manager, 'getSessionFile');
  nativeFile.mockReturnValue(path.join(root, 'foreign', 'session.jsonl'));
  await expect(extension.emit('agent_start')).rejects.toThrow(/root-relative/);
  nativeFile.mockRestore();
  await extension.emit('agent_settled');
  await extension.emit('session_shutdown');
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'activity'],
    [3, 'shutdown'],
  ]);
});

it('cannot emit through recovery hooks after rejecting a substituted native root on reload', async () => {
  const { extension, environment, manager, root, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  await extension.emit('session_shutdown', { reason: 'reload' });
  const substitute = path.join(root, 'substitute');
  const relative = path.relative(environment.PI_CODING_AGENT_DIR, manager.getSessionFile()!);
  const nativeFile = vi.spyOn(manager, 'getSessionFile');
  nativeFile.mockReturnValue(path.join(substitute, relative));
  const rejected = harness(manager);
  sessionLifecycle(rejected.api, { ...environment, PI_CODING_AGENT_DIR: substitute });
  await expect(rejected.emit('session_start', { reason: 'reload' })).rejects.toThrow(/native root/);
  await rejected.emit('agent_start');
  await rejected.emit('session_shutdown');
  expect((await events()).map(({ sequence }) => sequence)).toEqual([1, 2]);
  nativeFile.mockRestore();
  const recovered = harness(manager);
  sessionLifecycle(recovered.api, environment);
  await recovered.emit('session_start', { reason: 'reload' });
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'shutdown'],
    [3, 'start'],
  ]);
});

it('revalidates a failed native header without retaining its rejected activity', async () => {
  const { extension, environment, manager, events } = await fixture();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  await writeFile(manager.getSessionFile()!, '{\n');
  await expect(extension.emit('agent_start')).rejects.toThrow();
  expect(await events()).toEqual([]);
  await writeFile(manager.getSessionFile()!, `${JSON.stringify(manager.getHeader())}\n`);
  await extension.emit('session_shutdown');
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'shutdown'],
  ]);
});

it('retires and warns after failed shutdown without cancelling native replacement', async () => {
  const { extension, environment, manager, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  vi.mocked(link).mockRejectedValueOnce(new Error('transient publication failure'));
  await expect(extension.emit('session_shutdown', { reason: 'new' })).rejects.toThrow(/transient/);
  manager.newSession();
  const replacement = harness(manager);
  sessionLifecycle(replacement.api, environment);
  await expect(replacement.emit('session_start', { reason: 'new' })).resolves.toBeUndefined();
  await replacement.emit('agent_start');
  expect(replacement.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('not MPX launch-bound'),
    'warning',
  );
  expect(replacement.handlers.has('session_before_switch')).toBe(false);
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([[1, 'start']]);
});

it('rejects malformed replacement references after a failed shutdown, then permits a valid replacement', async () => {
  const { extension, environment, manager, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  vi.mocked(link).mockRejectedValueOnce(new Error('transient publication failure'));
  await expect(extension.emit('session_shutdown')).rejects.toThrow(/transient/);
  manager.newSession();
  const nativeFile = vi.spyOn(manager, 'getSessionFile');
  nativeFile.mockReturnValue(path.join(environment.PI_CODING_AGENT_DIR, 'bad\0session.jsonl'));
  const replacement = harness(manager);
  sessionLifecycle(replacement.api, environment);
  await expect(replacement.emit('session_start', { reason: 'new' })).rejects.toThrow();
  expect(replacement.notify).not.toHaveBeenCalled();
  nativeFile.mockRestore();
  await replacement.emit('session_start', { reason: 'new' });
  expect(replacement.notify).toHaveBeenCalledOnce();
});

it('detects event-directory replacement between validation and writer acquisition', async () => {
  const { extension, environment, prepared, root, events } = await fixture();
  const moved = path.join(root, 'moved-events');
  vi.mocked(extension.api.exec).mockImplementationOnce(async () => {
    await rename(prepared.eventDirectory, moved);
    await mkdir(prepared.eventDirectory);
    return { stdout: `${fingerprint}\n`, stderr: '', code: 0, killed: false };
  });
  sessionLifecycle(extension.api, environment);
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /binding changed/,
  );
  expect(await events()).toEqual([]);
  expect(await readdir(prepared.eventDirectory)).toEqual([]);
  expect(await readdir(moved)).toEqual([]);
});

it('rejects native-root directory drift until the original binding is restored', async () => {
  const { extension, environment, root, manager, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  await extension.emit('session_start', { reason: 'startup' });
  const nativeFile = manager.getSessionFile()!;
  const content = await readFile(nativeFile);
  const moved = path.join(root, 'moved-native');
  await rename(environment.PI_CODING_AGENT_DIR, moved);
  await mkdir(path.dirname(nativeFile), { recursive: true });
  await writeFile(nativeFile, content);
  await expect(extension.emit('agent_start')).rejects.toThrow(/binding changed/);
  await expect(extension.emit('agent_settled')).rejects.toThrow(/binding changed/);
  expect((await events()).map(({ sequence }) => sequence)).toEqual([1]);
  await rm(environment.PI_CODING_AGENT_DIR, { recursive: true });
  await rename(moved, environment.PI_CODING_AGENT_DIR);
  await extension.emit('session_shutdown');
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'shutdown'],
  ]);
});

it('never overwrites an existing final event during publication', async () => {
  const { extension, environment, events, persist } = await fixture();
  persist();
  sessionLifecycle(extension.api, environment);
  let collision: string | undefined;
  vi.mocked(link).mockImplementationOnce(async (source, destination) => {
    collision = String(destination);
    await writeFile(destination, 'existing protected content', { flag: 'wx' });
    await originalLink(source, destination);
  });
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(collision).toBeDefined();
  expect(await readFile(collision!, 'utf8')).toBe('existing protected content');
  await rm(collision!);
  await extension.emit('session_shutdown');
  expect((await events()).map(({ sequence, type }) => [sequence, type])).toEqual([
    [1, 'start'],
    [2, 'shutdown'],
  ]);
});

it('fails closed when the OS process fingerprint cannot be verified', async () => {
  const { extension, environment, events } = await fixture();
  vi.mocked(extension.api.exec).mockResolvedValue({
    stdout: '',
    stderr: 'unavailable',
    code: 1,
    killed: false,
  });
  sessionLifecycle(extension.api, environment);
  await expect(extension.emit('session_start', { reason: 'startup' })).rejects.toThrow(
    /birth verification failed/,
  );
  expect(await events()).toEqual([]);
});

it('loads the producer through production composition before active-registry cleanup', async () => {
  const { extension, environment, events, persist } = await fixture();
  persist();
  for (const [name, value] of Object.entries(environment)) {
    vi.stubEnv(name, value);
  }
  // Keep unrelated managed discovery disabled during native factory composition,
  // then restore the complete launch environment before lifecycle hooks run.
  const managedEnvironment = new Map(
    MANAGED_DISCOVERY_ENVIRONMENT.map((name) => [name, process.env[name]]),
  );
  for (const name of MANAGED_DISCOVERY_ENVIRONMENT) {
    vi.stubEnv(name, undefined);
  }
  await mpxPiExtensions(extension.api);
  for (const [name, value] of managedEnvironment) {
    vi.stubEnv(name, value);
  }
  expect(DEFAULT_EXTENSION_COMPONENTS.slice(0, 2).map(({ name }) => name)).toEqual([
    'session-lifecycle',
    'agent-resurrect',
  ]);
  await extension.handlers.get('session_start')![0]({ reason: 'startup' }, extension.context);
  await extension.handlers.get('session_shutdown')![0]({ reason: 'quit' }, extension.context);
  expect((await events()).map(({ type }) => type)).toEqual(['start', 'shutdown']);
});
