import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntimeContextV1, revalidateRuntimeArtifact } from '@mpx/runtime-contracts';
import {
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  inventoryProjectSkills,
  loadSkillBody,
  modelSearchSkillProjection,
  resolveManifest,
} from '@mpx/skills';
import {
  buildPiProjection,
  createPiRuntimeProfileV1,
  createPiRuntimeProjection,
  planPiInvocation,
  renderPiRuntimeStatus,
  verifyPiResumeTarget,
} from '../../src/index.js';
import { fixture } from '../fixtures/fixture.js';
import { compileContent } from '@mpx/content-compiler';

const originalRuntimeContext = process.env.MPX_RUNTIME_CONTEXT;
const originalProjectionReference = process.env.MPX_RUNTIME_PROJECTION_REFERENCE;
const originalStatusSnapshotFile = process.env.MPX_STATUS_SNAPSHOT_FILE;
const originalRuntimeStatusEnvelopeFile = process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE;
const originalLifecycleBindingId = process.env.MPX_SESSION_LIFECYCLE_BINDING_ID;
const originalLifecycleEventDirectory = process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR;
const originalPiCodingAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const originalCompiledAgentsDirectory = process.env.MPX_COMPILED_AGENTS_DIR;

function required<T>(value: T | undefined, label: string): T {
  expect(value, label).toBeDefined();
  if (value === undefined) {
    throw new Error(`${label} was not registered`);
  }
  return value;
}

async function compileFor(
  f: Awaited<ReturnType<typeof fixture>>,
  skillPlan: Awaited<ReturnType<typeof createSkillProjectionPlan>>,
) {
  return compileContent({
    runtime: 'pi',
    plan: skillPlan,
    runtimeProfiles: f.runtimeProfiles,
    sharedInstructionRoot: f.sharedInstructionRoot,
    agentRoot: f.agentRoot,
  });
}

afterEach(() => {
  if (originalRuntimeContext === undefined) {
    delete process.env.MPX_RUNTIME_CONTEXT;
  } else {
    process.env.MPX_RUNTIME_CONTEXT = originalRuntimeContext;
  }
  if (originalProjectionReference === undefined) {
    delete process.env.MPX_RUNTIME_PROJECTION_REFERENCE;
  } else {
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = originalProjectionReference;
  }
  if (originalStatusSnapshotFile === undefined) {
    delete process.env.MPX_STATUS_SNAPSHOT_FILE;
  } else {
    process.env.MPX_STATUS_SNAPSHOT_FILE = originalStatusSnapshotFile;
  }
  if (originalRuntimeStatusEnvelopeFile === undefined) {
    delete process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE;
  } else {
    process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE = originalRuntimeStatusEnvelopeFile;
  }
  for (const [name, value] of [
    ['MPX_SESSION_LIFECYCLE_BINDING_ID', originalLifecycleBindingId],
    ['MPX_SESSION_LIFECYCLE_EVENT_DIR', originalLifecycleEventDirectory],
    ['PI_CODING_AGENT_DIR', originalPiCodingAgentDirectory],
    ['MPX_COMPILED_AGENTS_DIR', originalCompiledAgentsDirectory],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('production Pi projection', () => {
  it('defers lifecycle start until native session metadata and its file exist', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-start-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-1';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(`${pathToFileURL(projection.extension).href}?start=${Date.now()}`);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });

    const sessionStart = required(
      required(events.get('session_start'), 'session start handlers').at(-1),
      'lifecycle session start handler',
    );
    await expect(
      sessionStart(
        {},
        {
          cwd: path.join(accountRoot, 'workspace'),
          sessionManager: {
            getSessionId: () => undefined,
            getSessionFile: () => undefined,
          },
          ui: { setStatus() {} },
        },
      ),
    ).resolves.toBeUndefined();
    expect(await readdir(eventDirectory)).toEqual([]);
  });

  it('defers lifecycle start when Pi reports metadata before creating the native file', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-file-race-')),
    });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    const nativeSessionFile = path.join(accountRoot, 'sessions', 'pending.jsonl');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-file-race';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(`${pathToFileURL(projection.extension).href}?race=${Date.now()}`);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });

    await expect(
      required(
        required(events.get('session_start'), 'session start handlers').at(-1),
        'lifecycle session start handler',
      )(
        {},
        {
          cwd: await mkdtemp(path.join(tmpdir(), 'pi-workspace-')),
          sessionManager: {
            getSessionId: () => 'pending',
            getSessionFile: () => nativeSessionFile,
          },
          ui: { setStatus() {} },
        },
      ),
    ).resolves.toBeUndefined();
    expect(await readdir(eventDirectory)).toEqual([]);
  });

  it('retries lifecycle capture on agent settled after native metadata becomes available', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-info-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-private-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    const cwd = await mkdtemp(path.join(tmpdir(), 'pi-workspace-'));
    const nativeSessionId = 'session-exact-1';
    const nativeSessionFile = path.join(accountRoot, 'sessions', `${nativeSessionId}.jsonl`);
    await mkdir(path.dirname(nativeSessionFile));
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-1';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(`${pathToFileURL(projection.extension).href}?info=${Date.now()}`);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    let metadataReady = false;
    const context = {
      cwd,
      model: { id: 'gpt-test' },
      sessionManager: {
        getSessionId: () => (metadataReady ? nativeSessionId : undefined),
        getSessionFile: () => (metadataReady ? nativeSessionFile : undefined),
        getSessionName: () => (metadataReady ? 'Lifecycle title' : undefined),
      },
      ui: { setStatus() {} },
    };
    await required(
      required(events.get('session_start'), 'session start handlers').at(-1),
      'lifecycle session start handler',
    )({}, context);
    await writeFile(nativeSessionFile, '{"type":"session"}\n');
    metadataReady = true;

    await required(
      required(events.get('agent_settled'), 'agent settled handlers').at(-1),
      'lifecycle agent settled handler',
    )({}, context);

    const eventFiles = await readdir(eventDirectory);
    expect(eventFiles).toHaveLength(1);
    const raw = await readFile(path.join(eventDirectory, required(eventFiles[0], 'event')), 'utf8');
    const event = JSON.parse(raw) as Record<string, unknown>;
    expect(event).toStrictEqual({
      schemaVersion: 1,
      eventId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      bindingId: 'binding-1',
      type: 'info',
      sequence: 1,
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
      nativeSessionId,
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/session-exact-1.jsonl' },
      cwd,
      title: 'Lifecycle title',
      model: 'gpt-test',
      effort: null,
      pid: process.pid,
      startFingerprint: expect.stringMatching(
        /^(?:unavailable:windows-process-start|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z)$/u,
      ),
    });
    expect(raw).not.toContain(accountRoot);
    expect(raw).not.toContain(accountRoot.replaceAll('\\', '/'));
  });

  it('emits lifecycle capture only once across repeated agent settled events', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-settled-once-')),
    });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    const nativeSessionFile = path.join(accountRoot, 'session.jsonl');
    await writeFile(nativeSessionFile, '{}\n');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-settled-once';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(`${pathToFileURL(projection.extension).href}?once=${Date.now()}`);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    let metadataReady = false;
    const context = {
      cwd: await mkdtemp(path.join(tmpdir(), 'pi-workspace-')),
      sessionManager: {
        getSessionId: () => (metadataReady ? 'settled-once' : undefined),
        getSessionFile: () => (metadataReady ? nativeSessionFile : undefined),
      },
      ui: { setStatus() {} },
    };
    await required(
      required(events.get('session_start'), 'session start handlers').at(-1),
      'lifecycle session start handler',
    )({}, context);
    metadataReady = true;
    const settled = required(
      required(events.get('agent_settled'), 'agent settled handlers').at(-1),
      'lifecycle agent settled handler',
    );

    await settled({}, context);
    await settled({}, context);
    await settled({}, context);

    const emitted = await Promise.all(
      (await readdir(eventDirectory)).map(
        async (file) =>
          JSON.parse(await readFile(path.join(eventDirectory, file), 'utf8')) as Record<
            string,
            unknown
          >,
      ),
    );
    expect(emitted.map(({ type, sequence }) => ({ type, sequence }))).toStrictEqual([
      { type: 'info', sequence: 1 },
    ]);
  });

  it('does not let a queued settled retry revive lifecycle info after shutdown begins', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-race-')),
    });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    const nativeSessionFile = path.join(accountRoot, 'session.jsonl');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-race';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(
      `${pathToFileURL(projection.extension).href}?race-stop=${Date.now()}`
    );
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    let metadataReady = false;
    const context = {
      cwd: await mkdtemp(path.join(tmpdir(), 'pi-workspace-')),
      sessionManager: {
        getSessionId: () => (metadataReady ? 'session-race' : undefined),
        getSessionFile: () => (metadataReady ? nativeSessionFile : undefined),
      },
      ui: { setStatus() {} },
    };
    await required(
      required(events.get('session_start'), 'session start handlers').at(-1),
      'lifecycle session start handler',
    )({}, context);
    await writeFile(nativeSessionFile, '{}\n');
    metadataReady = true;
    const settled = required(
      required(events.get('agent_settled'), 'agent settled handlers').at(-1),
      'lifecycle agent settled handler',
    )({}, context);
    const shutdown = required(
      required(events.get('session_shutdown'), 'session shutdown handlers').at(-1),
      'lifecycle session shutdown handler',
    )({}, context);

    await Promise.all([settled, shutdown]);

    const emitted = await Promise.all(
      (await readdir(eventDirectory)).map(
        async (file) =>
          JSON.parse(await readFile(path.join(eventDirectory, file), 'utf8')) as Record<
            string,
            unknown
          >,
      ),
    );
    expect(emitted.map(({ type, sequence }) => ({ type, sequence }))).toStrictEqual([
      { type: 'shutdown', sequence: 1 },
    ]);
  });

  it('serializes shutdown after an available native session and waits for lifecycle writes', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-shutdown-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    const nativeSessionFile = path.join(accountRoot, 'sessions', 'session-shutdown.jsonl');
    await mkdir(path.dirname(nativeSessionFile));
    await writeFile(nativeSessionFile, '{}\n');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-shutdown';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(
      `${pathToFileURL(projection.extension).href}?shutdown=${Date.now()}`
    );
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    const context = {
      cwd: await mkdtemp(path.join(tmpdir(), 'pi-workspace-')),
      sessionManager: {
        getSessionId: () => 'session-shutdown',
        getSessionFile: () => nativeSessionFile,
      },
      ui: { setStatus() {} },
    };
    const start = required(
      required(events.get('session_start'), 'session start handlers').at(-1),
      'lifecycle session start handler',
    )({}, context);
    const shutdown = required(
      required(events.get('session_shutdown'), 'session shutdown handlers').at(-1),
      'lifecycle session shutdown handler',
    )({}, context);
    await shutdown;
    await start;

    const emitted = await Promise.all(
      (await readdir(eventDirectory))
        .toSorted()
        .map(
          async (file) =>
            JSON.parse(await readFile(path.join(eventDirectory, file), 'utf8')) as Record<
              string,
              unknown
            >,
        ),
    );
    expect(emitted).toHaveLength(2);
    expect(emitted.map(({ type, sequence }) => ({ type, sequence }))).toStrictEqual([
      { type: 'start', sequence: 1 },
      { type: 'shutdown', sequence: 2 },
    ]);
    expect(emitted[1]).toMatchObject({
      bindingId: 'binding-shutdown',
      nativeSessionId: 'session-shutdown',
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/session-shutdown.jsonl' },
    });
  });

  it('fails closed at shutdown when known native session metadata names a missing file', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-missing-shutdown-')),
    });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    const nativeSessionFile = path.join(accountRoot, 'missing-session.jsonl');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-missing-shutdown';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(
      `${pathToFileURL(projection.extension).href}?missing=${Date.now()}`
    );
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    const context = {
      cwd: await mkdtemp(path.join(tmpdir(), 'pi-workspace-')),
      sessionManager: {
        getSessionId: () => 'missing-session',
        getSessionFile: () => nativeSessionFile,
      },
      ui: { setStatus() {} },
    };
    await required(
      required(events.get('session_start'), 'session start handlers').at(-1),
      'lifecycle session start handler',
    )({}, context);

    await expect(
      required(
        required(events.get('session_shutdown'), 'session shutdown handlers').at(-1),
        'lifecycle session shutdown handler',
      )({}, context),
    ).rejects.toThrow(/RESTART_REQUIRED: LIFECYCLE_METADATA_INVALID/u);
    expect(await readdir(eventDirectory)).toEqual([]);
  });

  it('treats a deliberate no-session context as lifecycle-silent through shutdown', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-no-session-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-no-session';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(`${pathToFileURL(projection.extension).href}?none=${Date.now()}`);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    const context = {
      cwd: await mkdtemp(path.join(tmpdir(), 'pi-workspace-')),
      sessionManager: {
        getSessionId: () => undefined,
        getSessionFile: () => undefined,
      },
      ui: { setStatus() {} },
    };

    for (const eventName of ['session_start', 'agent_settled', 'session_shutdown']) {
      await expect(
        required(
          required(events.get(eventName), `${eventName} handlers`).at(-1),
          `lifecycle ${eventName} handler`,
        )({}, context),
      ).resolves.toBeUndefined();
    }
    expect(await readdir(eventDirectory)).toEqual([]);
  });

  it('validates projection binding integrity before the settled lifecycle retry', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-integrity-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    const nativeSessionFile = path.join(accountRoot, 'session.jsonl');
    await writeFile(nativeSessionFile, '{}\n');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-integrity';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(
      `${pathToFileURL(projection.extension).href}?integrity=${Date.now()}`
    );
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify({ ...f.context, launchKey: 'tampered' });

    await expect(
      required(
        required(events.get('agent_settled'), 'agent settled handlers').at(-1),
        'lifecycle agent settled handler',
      )(
        {},
        {
          cwd: await mkdtemp(path.join(tmpdir(), 'pi-workspace-')),
          sessionManager: {
            getSessionId: () => 'session-integrity',
            getSessionFile: () => nativeSessionFile,
          },
        },
      ),
    ).rejects.toThrow(/RESTART_REQUIRED: LAUNCH_CONTEXT_CHANGED/u);
    expect(await readdir(eventDirectory)).toEqual([]);
  });

  it('fails closed for escaped and symlinked native session files after metadata appears', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-paths-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const eventDirectory = await mkdtemp(path.join(tmpdir(), 'pi-events-'));
    const outsideFile = path.join(
      await mkdtemp(path.join(tmpdir(), 'pi-outside-')),
      'session.jsonl',
    );
    const linkedFile = path.join(accountRoot, 'linked-session.jsonl');
    await writeFile(outsideFile, '{}\n');
    await symlink(outsideFile, linkedFile, 'file');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-paths';
    process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR = eventDirectory;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(`${pathToFileURL(projection.extension).href}?paths=${Date.now()}`);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    const settled = required(
      required(events.get('agent_settled'), 'agent settled handlers').at(-1),
      'lifecycle agent settled handler',
    );
    const cwd = await mkdtemp(path.join(tmpdir(), 'pi-workspace-'));

    for (const nativeFile of ['relative-session.jsonl', outsideFile, linkedFile]) {
      await expect(
        settled(
          {},
          {
            cwd,
            sessionManager: {
              getSessionId: () => 'session-paths',
              getSessionFile: () => nativeFile,
            },
          },
        ),
      ).rejects.toThrow(/RESTART_REQUIRED: LIFECYCLE_(?:SESSION_ESCAPE|METADATA_INVALID)/u);
    }
    expect(await readdir(eventDirectory)).toEqual([]);
  });

  it('fails closed when lifecycle event authority is missing after metadata appears', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-lifecycle-authority-')),
    });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-account-'));
    const nativeSessionFile = path.join(accountRoot, 'session.jsonl');
    await writeFile(nativeSessionFile, '{}\n');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    process.env.MPX_SESSION_LIFECYCLE_BINDING_ID = 'binding-authority';
    delete process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR;
    process.env.PI_CODING_AGENT_DIR = accountRoot;
    const module = await import(
      `${pathToFileURL(projection.extension).href}?authority=${Date.now()}`
    );
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });

    await expect(
      required(
        required(events.get('agent_settled'), 'agent settled handlers').at(-1),
        'lifecycle agent settled handler',
      )(
        {},
        {
          cwd: await mkdtemp(path.join(tmpdir(), 'pi-workspace-')),
          sessionManager: {
            getSessionId: () => 'session-authority',
            getSessionFile: () => nativeSessionFile,
          },
        },
      ),
    ).rejects.toThrow(/RESTART_REQUIRED: LIFECYCLE_BINDING_INVALID/u);
  });

  it('rejects an unverified plan before creating the artifacts root', async () => {
    const f = await fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'pi-unverified-plan-'));
    const artifactsRoot = path.join(parent, 'must-not-exist');
    await expect(
      buildPiProjection({
        skillPlan: structuredClone(f.skillPlan),
        compiledContent: f.compiledContent,
        context: f.context,
        expectedLaunch: f.expectedLaunch,
        currentBinding: f.currentBinding,
        artifactsRoot,
        statusSnapshot: f.statusSnapshot,
        runtimeStatusEnvelope: f.runtimeStatusEnvelope,
        piRuntimeProfile: f.piRuntimeProfile,
        launchBanner: f.launchBanner,
      }),
    ).rejects.toThrow('SKILL_PROJECTION_PLAN_UNVERIFIED');
    await expect(fs.promises.stat(artifactsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a mutated plan before creating the artifacts root', async () => {
    const f = await fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'pi-mutated-plan-'));
    const artifactsRoot = path.join(parent, 'must-not-exist');
    (f.skillPlan.entries[0] as { publicName: string }).publicName = '/mpx:changed';
    await expect(
      buildPiProjection({
        skillPlan: f.skillPlan,
        compiledContent: f.compiledContent,
        context: f.context,
        expectedLaunch: f.expectedLaunch,
        currentBinding: f.currentBinding,
        artifactsRoot,
        statusSnapshot: f.statusSnapshot,
        runtimeStatusEnvelope: f.runtimeStatusEnvelope,
        piRuntimeProfile: f.piRuntimeProfile,
        launchBanner: f.launchBanner,
      }),
    ).rejects.toThrow('SKILL_PROJECTION_PLAN_CHANGED');
    await expect(fs.promises.stat(artifactsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a malformed runtime profile before creating the artifacts root', async () => {
    const f = await fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'pi-malformed-profile-'));
    const artifactsRoot = path.join(parent, 'must-not-exist');
    const piRuntimeProfile = {
      ...f.piRuntimeProfile,
      capabilityIds: ['duplicate', 'duplicate'],
    };

    await expect(buildPiProjection({ ...f, artifactsRoot, piRuntimeProfile })).rejects.toThrowError(
      expect.objectContaining({ code: 'PI_RUNTIME_PROFILE_INVALID' }),
    );
    await expect(fs.promises.stat(artifactsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the shared lazy loader canonical hash and normalized provenance wrapper', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-provenance-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let loadTool:
      | {
          execute(
            id: string,
            params: { identity: string },
          ): Promise<{ content: Array<{ text: string }>; details: { provenance: unknown } }>;
        }
      | undefined;
    const pi = {
      registerCommand() {},
      registerTool(tool: {
        name: string;
        execute(
          id: string,
          params: { identity: string },
        ): Promise<{ content: Array<{ text: string }>; details: { provenance: unknown } }>;
      }) {
        if (tool.name === 'mpx_model_load') {
          loadTool = tool;
        }
      },
    };
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate(pi);
    const projected = await required(loadTool, 'model load tool').execute('load', {
      identity: 'full',
    });
    const canonical = await loadSkillBody({
      canonicalRoot: f.canonicalRoot,
      manifest: f.manifest,
      artifact: f.artifact,
      runtime: 'pi',
      identity: 'full',
      invocation: 'model',
    });
    const claudeArtifact = createRuntimeSkillArtifact(f.manifest, f.catalog, { runtime: 'claude' });
    const claude = await loadSkillBody({
      canonicalRoot: f.canonicalRoot,
      manifest: f.manifest,
      artifact: claudeArtifact,
      runtime: 'claude',
      identity: 'full',
      invocation: 'model',
    });
    const compiledSkill = f.compiledContent.manifest.skills.find(
      (entry) => entry.identity === 'full',
    )!;
    expect(required(projected.content[0], 'projected content').text).toBe(
      `<!-- mpx-skill identity=full origin=model runtime=pi artifact=${f.artifact.reference.artifactKey} hash=${compiledSkill.generatedSha256} -->\n${canonical.body}<!-- /mpx-skill -->`,
    );
    expect(projected.details.provenance).toMatchObject({
      contentHash: compiledSkill.generatedSha256,
      sourcePath: canonical.provenance.sourcePath,
    });
    expect({ body: canonical.body, sourcePath: canonical.provenance.sourcePath }).toEqual({
      body: claude.body,
      sourcePath: claude.provenance.sourcePath,
    });
  });

  it('loads an exact project body through the generated extension and native Pi skills', async () => {
    const f = await fixture();
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'pi-project-skill-'));
    const directory = path.join(projectRoot, '.agents', 'skills', 'local');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: local\ndescription: Local project skill\nmetadata:\n  mpx:\n    projectExposure: full\n---\nEXACT PROJECT BODY\n',
    );
    const projectCatalog = (await inventoryProjectSkills(projectRoot, f.catalog)).skills;
    const catalog = [...f.catalog, ...projectCatalog];
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      projectId: 'p',
      contentScope: 'scope',
      enabledPacks: ['core'],
      identity: 'id',
      skillPolicy: 'policy',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
    const context = createRuntimeContextV1({
      ...f.context,
      manifestKey: manifest.manifestKey,
      runtimeArtifact: artifact.reference,
      binding: manifest.binding,
    });
    const skillPlan = await createSkillProjectionPlan({
      catalog,
      manifest,
      artifact,
      canonicalRoot: f.canonicalRoot,
    });
    const compiledContent = await compileFor(f, skillPlan);
    const projection = await buildPiProjection({
      ...f,
      skillPlan,
      compiledContent,
      context,
      currentBinding: manifest.binding,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-project-projection-')),
    });
    const plan = planPiInvocation({
      executable: 'C:/trusted/pi.exe',
      accountRoot: 'C:/native/pi',
      cwd: 'C:/repo',
      runtimeContext: context,
      projection,
    });
    expect(plan.args).toContain('--skill');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const module = await import(pathToFileURL(projection.extension).href);
    let loadTool:
      | {
          execute(
            id: string,
            params: { identity: string },
          ): Promise<{ content: Array<{ text: string }> }>;
        }
      | undefined;
    await module.activate({
      registerCommand() {},
      registerTool(tool: {
        name: string;
        execute(
          id: string,
          params: { identity: string },
        ): Promise<{ content: Array<{ text: string }> }>;
      }) {
        if (tool.name === 'mpx_model_load') {
          loadTool = tool;
        }
      },
    });
    const loaded = await required(loadTool, 'model load tool').execute('load', {
      identity: 'local',
    });
    expect(required(loaded.content[0], 'loaded project content').text).toContain(
      'EXACT PROJECT BODY',
    );
  });

  it('rejects a project skill pathname swap between validation and publication', async () => {
    const f = await fixture();
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'pi-project-path-swap-'));
    const directory = path.join(projectRoot, '.agents', 'skills', 'local');
    const source = path.join(directory, 'SKILL.md');
    const trusted =
      '---\nname: local\ndescription: Local project skill\nmetadata:\n  mpx:\n    projectExposure: full\n---\nSAFE PROJECT BODY\n';
    const replacement = trusted.replace('SAFE', 'EVIL');
    await mkdir(directory, { recursive: true });
    await writeFile(source, trusted);
    const projectCatalog = (await inventoryProjectSkills(projectRoot, f.catalog)).skills;
    const catalog = [...f.catalog, ...projectCatalog];
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      projectId: 'p',
      contentScope: 'scope',
      enabledPacks: ['core'],
      identity: 'id',
      skillPolicy: 'policy',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
    const replacementFile = path.join(projectRoot, 'replacement.md');
    await writeFile(replacementFile, replacement);
    const originalReadFile = fs.promises.readFile;
    let swapped = false;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(
      async (...args: Parameters<typeof fs.promises.readFile>) => {
        const bytes = await originalReadFile(...args);
        if (!swapped && path.resolve(String(args[0])) === path.resolve(source)) {
          swapped = true;
          await rename(source, `${source}.validated`);
          await rename(replacementFile, source);
        }
        return bytes as never;
      },
    );
    syncBuiltinESMExports();

    await expect(
      createSkillProjectionPlan({
        catalog,
        manifest,
        artifact,
        canonicalRoot: f.canonicalRoot,
      }),
    ).rejects.toThrow();
    expect(swapped).toBe(true);
  });

  it('rejects a same-size project skill replacement between validation and publication', async () => {
    const f = await fixture();
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'pi-project-content-swap-'));
    const directory = path.join(projectRoot, '.agents', 'skills', 'local');
    const source = path.join(directory, 'SKILL.md');
    const trusted =
      '---\nname: local\ndescription: Local project skill\nmetadata:\n  mpx:\n    projectExposure: full\n---\nSAFE PROJECT BODY\n';
    const replacement = trusted.replace('SAFE', 'EVIL');
    await mkdir(directory, { recursive: true });
    await writeFile(source, trusted);
    const projectCatalog = (await inventoryProjectSkills(projectRoot, f.catalog)).skills;
    const catalog = [...f.catalog, ...projectCatalog];
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      projectId: 'p',
      contentScope: 'scope',
      enabledPacks: ['core'],
      identity: 'id',
      skillPolicy: 'policy',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
    const originalReadFile = fs.promises.readFile;
    let replaced = false;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(
      async (...args: Parameters<typeof fs.promises.readFile>) => {
        const bytes = await originalReadFile(...args);
        if (!replaced && path.resolve(String(args[0])) === path.resolve(source)) {
          replaced = true;
          await writeFile(source, replacement);
        }
        return bytes as never;
      },
    );
    syncBuiltinESMExports();

    await expect(
      createSkillProjectionPlan({
        catalog,
        manifest,
        artifact,
        canonicalRoot: f.canonicalRoot,
      }),
    ).rejects.toThrow();
    expect(replaced).toBe(true);
  });

  it('publishes an immutable deterministic self-contained policy projection', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-projections-'));
    const input = { ...f, artifactsRoot };

    const first = await buildPiProjection(input);
    const second = await createPiRuntimeProjection(input);

    expect(second).toEqual({ ...first, reused: true });
    expect(Object.isFrozen(first)).toBe(true);
    expect(
      await revalidateRuntimeArtifact(first.revalidation.directory, first.revalidation.reference),
    ).toMatchObject({ valid: true });
    expect(first.files).toEqual(
      expect.arrayContaining([
        'extension.mjs',
        'runtime-context.json',
        'runtime-profile.json',
        'projection.json',
        'settings.json',
        'keybindings.json',
        'status/runtime-status-envelope-v1.json',
        'themes/green.json',
        'themes/amber.json',
        'vendor/subagents/VENDORED.md',
        'vendor/subagents/LICENSE',
      ]),
    );
    const projectedAgents = first.files.filter((file) =>
      /^agents\/(?:mpx-[a-z0-9-]+|Explore)\.md$/u.test(file),
    );
    expect(projectedAgents).toHaveLength(22);
    expect(projectedAgents.filter((file) => file === 'agents/Explore.md')).toHaveLength(1);
    expect(projectedAgents).not.toContain('agents/mpx-explorer.md');
    expect(first.files).toEqual(
      expect.arrayContaining([
        'active-content.json',
        'skills/explicit/SKILL.md',
        'skills/full/SKILL.md',
        'skills/named/SKILL.md',
      ]),
    );
    expect(first.files).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/(?:^|\/)body\.md$|pnpm-lock\.yaml$/u)]),
    );

    const descriptor = JSON.parse(
      await readFile(path.join(first.directory, 'projection.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      runtime: 'pi',
      commandAllowlist: ['mpx:explicit', 'mpx:full', 'mpx:named'],
      modelSearchAllowlist: ['full', 'named'],
      profile: 'runtime-profile.json',
    });
    expect(
      JSON.parse(await readFile(path.join(first.directory, 'runtime-profile.json'), 'utf8')),
    ).toEqual(f.piRuntimeProfile);
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain(f.canonicalRoot);
    expect(serialized).not.toMatch(/credential|session|nativeSkillAliases/iu);
    const extensionSource = await readFile(first.extension, 'utf8');
    expect(extensionSource).not.toContain(f.canonicalRoot);
    expect(extensionSource).not.toMatch(/regularFile|boundMetadata|\breadFile\b|\breaddir\b/u);
    expect(await readFile(path.join(first.directory, 'skills', 'full', 'SKILL.md'))).toEqual(
      Buffer.from(
        f.compiledContent.files.find((file) => file.relativePath === 'skills/full/SKILL.md')!.bytes,
      ),
    );
    expect((await readdir(path.join(first.directory, 'skills'))).sort()).toEqual([
      'explicit',
      'full',
      'named',
      'shared',
    ]);
    expect(
      await readFile(path.join(first.directory, 'status', 'status-snapshot.json'), 'utf8'),
    ).toBe(`${JSON.stringify(f.statusSnapshot, null, 2)}\n`);
  });

  it('publishes every compiler-owned file byte-for-byte without a body.md representation', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-compiler-pass-through-')),
    });
    for (const file of f.compiledContent.files) {
      expect(
        await readFile(path.join(projection.directory, ...file.relativePath.split('/'))),
      ).toEqual(Buffer.from(file.bytes));
    }
    expect(projection.files.some((file) => file.endsWith('/body.md'))).toBe(false);
  });

  it('changes publication identity and reuse when the validated runtime profile changes', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-profile-binding-'));
    const first = await buildPiProjection({ ...f, artifactsRoot });
    const reused = await buildPiProjection({ ...f, artifactsRoot });
    const workProfile = createPiRuntimeProfileV1(
      {
        schemaVersion: 1,
        runtime: 'pi',
        provider: 'anthropic',
        defaultModel: 'anthropic/claude-sonnet-4-6',
        enabledModels: ['anthropic/claude-sonnet-4-6'],
      },
      [],
    );
    const changed = await buildPiProjection({
      ...f,
      artifactsRoot,
      piRuntimeProfile: workProfile,
    });

    expect(reused).toEqual({ ...first, reused: true });
    expect(changed.reused).toBe(false);
    expect(changed.reference.projectionKey).not.toBe(first.reference.projectionKey);
    expect(changed.reference.fileMapHash).not.toBe(first.reference.fileMapHash);
    expect(changed.revalidation.profile).toEqual(workProfile);
  });

  it('binds the invocation profile bytes into projection revalidation', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-profile-revalidation-')),
    });
    const profileFile = path.join(projection.directory, 'runtime-profile.json');
    await writeFile(
      profileFile,
      (await readFile(profileFile, 'utf8')).replace('gpt-5.6-sol', 'gpt-5.6-luna'),
    );

    await expect(
      revalidateRuntimeArtifact(
        projection.revalidation.directory,
        projection.revalidation.reference,
      ),
    ).resolves.toMatchObject({ valid: false });
  });

  it('binds a one-byte support-file change into projected file metadata and its aggregate digest', async () => {
    const f = await fixture();
    const supportPath = path.join(f.canonicalRoot, 'full', 'guide.txt');
    const build = async (suffix: string) => {
      const skillPlan = await createSkillProjectionPlan({
        manifest: f.manifest,
        artifact: f.artifact,
        catalog: f.catalog,
        canonicalRoot: f.canonicalRoot,
      });
      const compiledContent = await compileFor(f, skillPlan);
      const projection = await buildPiProjection({
        ...f,
        skillPlan,
        compiledContent,
        artifactsRoot: await mkdtemp(path.join(tmpdir(), `pi-support-byte-${suffix}-`)),
      });
      const metadata = JSON.parse(
        await readFile(path.join(projection.directory, '.mpx-runtime-artifact.json'), 'utf8'),
      ) as { fileMap: Array<{ path: string; bytes: number; sha256: string }> };
      return {
        projection,
        supportMetadata: required(
          metadata.fileMap.find((entry) => entry.path === 'skills/full/guide.txt'),
          'projected support-file metadata',
        ),
      };
    };

    await writeFile(supportPath, 'SUPPORT A\n');
    const first = await build('a');
    await writeFile(supportPath, 'SUPPORT B\n');
    const second = await build('b');

    expect(second.supportMetadata).not.toEqual(first.supportMetadata);
    expect(second.supportMetadata.bytes).toBe(first.supportMetadata.bytes);
    expect(second.supportMetadata.sha256).not.toBe(first.supportMetadata.sha256);
    expect(second.projection.reference.fileMapHash).not.toBe(
      first.projection.reference.fileMapHash,
    );
  });

  it('accepts a canonical published file map with hyphenated agent names', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-hyphenated-map-')),
    });
    const metadata = JSON.parse(
      await readFile(path.join(projection.directory, '.mpx-runtime-artifact.json'), 'utf8'),
    ) as { fileMap: Array<{ path: string }> };
    const paths = metadata.fileMap.map((entry) => entry.path);
    expect(paths.indexOf('agents/mpx-check-fixer.md')).toBeLessThan(
      paths.indexOf('agents/mpx-checker.md'),
    );

    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const module = await import(pathToFileURL(projection.extension).href);
    await expect(module.activate({ registerCommand() {} })).resolves.toBeUndefined();
  });

  it('copies canonical support assets and binds their bytes into full projection revalidation', async () => {
    const f = await fixture();
    await mkdir(path.join(f.canonicalRoot, 'full', 'references'));
    await writeFile(
      path.join(f.canonicalRoot, 'full', 'references', 'guide.txt'),
      'trusted support\n',
    );
    await writeFile(path.join(f.canonicalRoot, 'full', 'script.js'), 'export default 1;\n');
    const skillPlan = await createSkillProjectionPlan({
      manifest: f.manifest,
      artifact: f.artifact,
      catalog: f.catalog,
      canonicalRoot: f.canonicalRoot,
    });
    const compiledContent = await compileFor(f, skillPlan);
    const projection = await buildPiProjection({
      ...f,
      skillPlan,
      compiledContent,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-support-')),
    });
    expect(
      await readFile(
        path.join(projection.directory, 'skills', 'full', 'references', 'guide.txt'),
        'utf8',
      ),
    ).toBe('trusted support\n');
    expect(projection.files).toContain('skills/full/script.js');
    await writeFile(path.join(projection.directory, 'skills', 'full', 'script.js'), 'tampered\n');
    await expect(
      revalidateRuntimeArtifact(projection.directory, projection.reference),
    ).resolves.toMatchObject({ valid: false });
  });

  it('rejects symlinked runtime-assets/themes roots before reading themes', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-projections-'));
    const assetsTarget = await mkdtemp(path.join(tmpdir(), 'pi-assets-target-'));
    await mkdir(path.join(assetsTarget, 'themes'));
    const linkedAssetsRoot = path.join(
      await mkdtemp(path.join(tmpdir(), 'pi-assets-link-')),
      'projection-link',
    );
    await symlink(
      assetsTarget,
      linkedAssetsRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      buildPiProjection({ ...f, artifactsRoot, assetsRoot: linkedAssetsRoot }),
    ).rejects.toThrow(/assets|symlink/i);
  });

  it('plans Pi from projection revalidation data and a private native account root', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-projections-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const plan = planPiInvocation({
      executable: 'C:/trusted/pi.cmd',
      projection,
      accountRoot: 'C:/private/pi/account-a',
      runtimeContext: f.context,
      cwd: 'C:/repo',
    });
    expect(projection.profile).toEqual(f.piRuntimeProfile);
    expect(plan.args).toEqual([
      '--no-extensions',
      '--extension',
      projection.extension.replaceAll('\\', '/'),
      '--no-skills',
      '--skill',
      path.join(projection.directory, 'skills', 'explicit').replaceAll('\\', '/'),
      '--skill',
      path.join(projection.directory, 'skills', 'full').replaceAll('\\', '/'),
      '--skill',
      path.join(projection.directory, 'skills', 'named').replaceAll('\\', '/'),
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.6-sol',
      '--thinking',
      'medium',
      '--tui-mode',
      'fullscreen',
      '--theme',
      'dark',
    ]);
    expect(plan.args).not.toContain('--no-skill-commands');
    expect(plan.env).toEqual({
      PI_CODING_AGENT_DIR: 'C:/private/pi/account-a',
      MPX_RUNTIME: 'pi',
      MPX_RUNTIME_CONTEXT: JSON.stringify(f.context),
      MPX_RUNTIME_CONTEXT_FILE: projection.runtimeContextFile.replaceAll('\\', '/'),
      MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(projection.reference),
      MPX_ACTIVE_CONTENT_ROOT: projection.directory.replaceAll('\\', '/'),
      MPX_ACTIVE_CONTENT_MANIFEST: path
        .join(projection.directory, 'active-content.json')
        .replaceAll('\\', '/'),
      MPX_COMPILED_AGENTS_DIR: path.join(projection.directory, 'agents').replaceAll('\\', '/'),
    });
    expect(projection.revalidation).toEqual({
      directory: projection.directory,
      reference: projection.reference,
      profile: f.piRuntimeProfile,
    });
  });

  it('pins compiler-owned agents for a resumed sandbox launch despite an attacker environment override', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-resume-agents-')),
    });
    const accountRoot = await mkdtemp(path.join(tmpdir(), 'pi-resume-account-'));
    const sessionFile = path.join(accountRoot, 'sessions', 'resume.jsonl');
    await mkdir(path.dirname(sessionFile));
    await writeFile(sessionFile, '{}\n');
    const resumeTarget = await verifyPiResumeTarget(accountRoot, {
      kind: 'root-relative-file',
      value: 'sessions/resume.jsonl',
    });
    process.env.MPX_COMPILED_AGENTS_DIR = 'C:/attacker/agents';

    const plan = planPiInvocation({
      executable: 'C:/trusted/pi.cmd',
      projection,
      accountRoot,
      runtimeContext: f.context,
      cwd: 'C:/repo',
      resumeTarget,
      bridge: {
        schemaVersion: 1,
        endpoint: 'tcp://127.0.0.1:43123',
        nonce: 'a'.repeat(64),
        launchKey: f.context.launchKey,
        identity: { name: 'work', domain: 'work' },
        planKey: 'b'.repeat(64),
        runtimeToolInventorySha256: 'c'.repeat(64),
        capabilitySha256: 'd'.repeat(64),
      },
    });

    expect(plan.env.MPX_COMPILED_AGENTS_DIR).toBe(
      path.join(projection.directory, 'agents').replaceAll('\\', '/'),
    );
    expect(plan.env.MPX_COMPILED_AGENTS_DIR).not.toBe(process.env.MPX_COMPILED_AGENTS_DIR);
    expect(plan.args.slice(-2)).toEqual(['--session', sessionFile.replaceAll('\\', '/')]);
  });

  it('loads the bound profile when the published projection is passed as flattened launch data', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-flattened-profile-')),
    });
    const plan = planPiInvocation({
      executable: 'C:/trusted/pi.cmd',
      extension: projection.extension,
      theme: 'green',
      accountRoot: 'C:/private/pi/account-a',
      runtimeContextFile: projection.runtimeContextFile,
      runtimeContext: f.context,
      projectionReference: projection.reference,
      immutableProjectionDirectory: projection.directory,
      cwd: 'C:/repo',
    });

    expect(plan.env.MPX_COMPILED_AGENTS_DIR).toBe(
      path.join(projection.directory, 'agents').replaceAll('\\', '/'),
    );
    expect(plan.args.slice(3)).toEqual([
      '--no-skills',
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.6-sol',
      '--thinking',
      'medium',
      '--tui-mode',
      'fullscreen',
      '--theme',
      'dark',
    ]);
  });

  it('renders the runtime status envelope rather than the legacy port-only footer', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-projections-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    let piStatus = '';
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    const sessionStart = required(
      required(events.get('session_start'), 'session start handlers')[0],
      'session start handler',
    );
    await sessionStart(
      {},
      {
        ui: {
          setStatus: (_key: string, text: string) => {
            piStatus = text;
          },
        },
      },
    );
    expect(piStatus).toContain('Personal · Sol · app@main · 1k/272k');
    expect(piStatus).not.toMatch(/\bports\b/u);
  });

  it('publishes one compiled content tree without rereading canonical agent sources', async () => {
    const f = await fixture();
    const contentRoot = await mkdtemp(path.join(tmpdir(), 'pi-compiled-content-'));
    const sharedInstructionRoot = path.join(contentRoot, 'instructions', 'shared');
    const agentRoot = path.join(contentRoot, 'agents');
    await Promise.all([
      cp(f.sharedInstructionRoot, sharedInstructionRoot, { recursive: true }),
      cp(f.agentRoot, agentRoot, { recursive: true }),
    ]);
    const compiledContent = await compileContent({
      runtime: 'pi',
      plan: f.skillPlan,
      runtimeProfiles: f.runtimeProfiles,
      sharedInstructionRoot,
      agentRoot,
    });
    const expectedAgent = required(
      compiledContent.files.find((file) => file.relativePath === 'agents/Explore.md'),
      'compiled Explore agent',
    );
    await rm(contentRoot, { recursive: true, force: true });

    const projection = await buildPiProjection({
      ...f,
      compiledContent,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-precompiled-projection-')),
    });

    expect(await readFile(path.join(projection.directory, expectedAgent.relativePath))).toEqual(
      Buffer.from(expectedAgent.bytes),
    );
  });

  it('keeps discovery and agent-start cheap while selected skill load catches support tamper', async () => {
    const f = await fixture();
    await writeFile(path.join(f.canonicalRoot, 'full', 'guide.txt'), 'trusted\n');
    const skillPlan = await createSkillProjectionPlan({
      manifest: f.manifest,
      artifact: f.artifact,
      catalog: f.catalog,
      canonicalRoot: f.canonicalRoot,
    });
    const compiledContent = await compileFor(f, skillPlan);
    const projection = await buildPiProjection({
      ...f,
      skillPlan,
      compiledContent,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-costs-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    const tools = new Map<string, { execute(id: string, params: unknown): Promise<unknown> }>();
    const events = new Map<string, (...args: unknown[]) => unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, handler);
      },
    });
    await writeFile(path.join(projection.directory, 'skills', 'full', 'guide.txt'), 'altered\n');
    await expect(
      required(tools.get('mpx_model_search'), 'model search tool').execute('search', {
        query: 'full',
      }),
    ).resolves.toBeDefined();
    await expect(
      required(
        events.get('before_agent_start'),
        'before agent start handler',
      )({
        systemPrompt: 'BASE',
      }),
    ).resolves.toBeDefined();
    await expect(
      required(tools.get('mpx_model_load'), 'model load tool').execute('load', {
        identity: 'full',
      }),
    ).rejects.toThrow('RESTART_REQUIRED');
    await expect(
      required(events.get('session_start'), 'session start handler')(
        {},
        { ui: { setStatus() {} } },
      ),
    ).rejects.toThrow('RESTART_REQUIRED');
  });

  it('rejects same-size pathname replacement of a selected skill body', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-swap-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let load: { execute(id: string, params: unknown): Promise<unknown> } | undefined;
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        if (tool.name === 'mpx_model_load') {
          load = tool;
        }
      },
    });
    const body = path.join(projection.directory, 'skills', 'full', 'SKILL.md');
    const original = await readFile(body);
    await rename(body, `${body}.old`);
    await writeFile(body, Buffer.alloc(original.length, 88));
    await expect(
      required(load, 'model load tool').execute('load', { identity: 'full' }),
    ).rejects.toThrow('RESTART_REQUIRED');
  });

  it('rejects pathname replacement of a selected skill body after opening its handle', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-open-swap-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let load: { execute(id: string, params: unknown): Promise<unknown> } | undefined;
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        if (tool.name === 'mpx_model_load') {
          load = tool;
        }
      },
    });
    const body = path.join(projection.directory, 'skills', 'full', 'SKILL.md');
    const original = await readFile(body);
    const replacement = `${body}.replacement`;
    await writeFile(replacement, original);
    const probe = await open(body, 'r');
    const bodyStat = await probe.stat();
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: (...args: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let replaced = false;
    vi.spyOn(fileHandlePrototype, 'read').mockImplementation(async function (
      this: { stat(): Promise<{ dev: number | bigint; ino: number | bigint }> },
      ...args: unknown[]
    ) {
      const openedStat = await this.stat();
      if (!replaced && openedStat.dev === bodyStat.dev && openedStat.ino === bodyStat.ino) {
        replaced = true;
        await rename(body, `${body}.old`);
        await rename(replacement, body);
      }
      return originalRead.apply(this, args);
    });

    await expect(
      required(load, 'model load tool').execute('load', { identity: 'full' }),
    ).rejects.toThrow('RESTART_REQUIRED: SKILL_BODY_INVALID');
    expect(replaced).toBe(true);
  });

  it('rejects same-size in-place mutation of a selected skill body', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-mutation-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let load: { execute(id: string, params: unknown): Promise<unknown> } | undefined;
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        if (tool.name === 'mpx_model_load') {
          load = tool;
        }
      },
    });
    const body = path.join(projection.directory, 'skills', 'full', 'SKILL.md');
    const original = await readFile(body);
    await writeFile(body, Buffer.alloc(original.length, 89));
    await expect(
      required(load, 'model load tool').execute('load', { identity: 'full' }),
    ).rejects.toThrow('RESTART_REQUIRED');
  });

  it('rejects bounded-metadata violations before projection traversal', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-bounds-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const metadataFile = path.join(projection.directory, '.mpx-runtime-artifact.json');
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as {
      schemaVersion: number;
      reference: unknown;
      fileMap: unknown[];
    };
    metadata.fileMap = Array.from({ length: 10_001 }, (_, index) => ({
      path: `overflow/${index}`,
      sha256: '0'.repeat(64),
      bytes: 0,
    }));
    await writeFile(metadataFile, JSON.stringify(metadata));
    await expect(module.activate({ registerCommand() {} })).rejects.toThrow(
      'RESTART_REQUIRED: ARTIFACT_BINDING_CHANGED',
    );
  });

  it('rejects unsafe, duplicate, over-depth, and over-aggregate file maps', async () => {
    const cases: Array<{ name: string; fileMap: unknown[] }> = [
      { name: 'unsafe', fileMap: [{ path: '../escape', sha256: '0'.repeat(64), bytes: 0 }] },
      {
        name: 'duplicate',
        fileMap: [
          { path: 'same', sha256: '0'.repeat(64), bytes: 0 },
          { path: 'same', sha256: '0'.repeat(64), bytes: 0 },
        ],
      },
      {
        name: 'depth',
        fileMap: [{ path: `${'directory/'.repeat(64)}file`, sha256: '0'.repeat(64), bytes: 0 }],
      },
      {
        name: 'aggregate',
        fileMap: Array.from({ length: 17 }, (_, index) => ({
          path: `large/${index}`,
          sha256: '0'.repeat(64),
          bytes: 16 * 1024 * 1024,
        })),
      },
    ];
    for (const candidate of cases) {
      const f = await fixture();
      const projection = await buildPiProjection({
        ...f,
        artifactsRoot: await mkdtemp(path.join(tmpdir(), `pi-${candidate.name}-`)),
      });
      const module = await import(pathToFileURL(projection.extension).href);
      process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
      process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
      const metadataFile = path.join(projection.directory, '.mpx-runtime-artifact.json');
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as { fileMap: unknown[] };
      metadata.fileMap = candidate.fileMap;
      await writeFile(metadataFile, JSON.stringify(metadata));
      await expect(module.activate({ registerCommand() {} }), candidate.name).rejects.toThrow(
        'RESTART_REQUIRED: ARTIFACT_BINDING_CHANGED',
      );
    }
  });

  it('rejects unexpected projection entries immediately, including deep directory trees', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-tree-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await mkdir(
      path.join(
        projection.directory,
        'unexpected',
        ...Array.from({ length: 70 }, (_, index) => `d${index}`),
      ),
      { recursive: true },
    );
    await expect(module.activate({ registerCommand() {} })).rejects.toThrow(
      'RESTART_REQUIRED: ARTIFACT_FILE_MAP_CHANGED',
    );
  });

  it('binds the privacy-safe runtime envelope into immutable projection metadata', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-runtime-status-')),
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(projection.directory, 'status', 'runtime-status-envelope-v1.json'),
          'utf8',
        ),
      ),
    ).toEqual(f.runtimeStatusEnvelope);
    const source = await readFile(projection.extension, 'utf8');
    expect(source).not.toMatch(/auth\.json|jwt|bearer|credential/iu);
  });

  it('rejects embedded Bash policy tamper before classifying a command', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-policy-tamper-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    const events = new Map<string, (...args: unknown[]) => unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, handler);
      },
    });
    await writeFile(
      path.join(projection.directory, 'dangerous-command-policy.mjs'),
      "export const classifyDangerousCommand=()=>({action:'allow'});\n",
    );
    await expect(
      required(
        events.get('tool_call'),
        'tool call handler',
      )({
        toolName: 'bash',
        input: { command: 'rm -rf /' },
      }),
    ).rejects.toThrow('RESTART_REQUIRED');
  });

  it('registers the shared dangerous-command policy for native bash calls only', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-policy-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    const events = new Map<string, (...args: unknown[]) => unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, handler);
      },
    });
    const policy = required(events.get('tool_call'), 'tool call handler');
    await expect(policy({ toolName: 'bash', input: { command: 'rm -rf /' } })).resolves.toEqual({
      block: true,
      reason:
        'DANGEROUS_RECURSIVE_DELETE: Blocked: broad recursive deletion is not allowed.\nRun manually only after review: rm -rf /',
    });
    await expect(
      policy({ toolName: 'bash', input: { command: 'rm -rf dist' } }),
    ).resolves.toBeUndefined();
    await expect(
      policy({ toolName: 'bash', input: { command: 'remove=rm; $remove -rf /' } }),
    ).resolves.toEqual({
      block: true,
      reason:
        'DANGEROUS_RECURSIVE_DELETE: Blocked: broad recursive deletion is not allowed.\nRun manually only after review: remove=rm; $remove -rf /',
    });
    await expect(
      policy({ toolName: 'bash', input: { command: 'echo $remove -rf /' } }),
    ).resolves.toBeUndefined();
    await expect(
      policy({ toolName: 'read', input: { command: 'rm -rf /' } }),
    ).resolves.toBeUndefined();
  });

  it('executes every projected production policy handler with its previous outcomes', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-policy-handlers-')),
    });
    const module = await import(
      `${pathToFileURL(projection.extension).href}?policy-handlers=${Date.now()}`
    );
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notifications: Array<[string, string]> = [];
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });

    const productionHandler = (name: string) =>
      required(required(events.get(name), `${name} handlers`)[0], `${name} production handler`);
    await expect(
      productionHandler('tool_call')({ toolName: 'bash', input: { command: 'npm install' } }),
    ).resolves.toMatchObject({
      block: true,
      reason: 'WRONG_PACKAGE_MANAGER: This project uses pnpm; use it instead of npm.',
    });
    await expect(
      productionHandler('tool_result')({ toolName: 'write', input: { path: 'src/example.ts' } }),
    ).resolves.toEqual({ additionalContext: 'post-write quality: []' });
    await expect(
      productionHandler('tool_result')({
        toolName: 'bash',
        input: { command: 'pnpm install' },
        result: { stderr: 'found 1 vulnerability in dependency tree' },
      }),
    ).resolves.toEqual({
      additionalContext:
        'Package install detected vulnerabilities. Consider running the project audit policy.',
    });
    await expect(
      productionHandler('session_before_compact')({ customInstructions: 'Keep local context.' }),
    ).resolves.toEqual({
      instructions: 'Keep local context.\n\nPreserve immutable launch authority.',
    });
    await expect(
      productionHandler('agent_settled')(
        {},
        {
          ui: {
            notify(message: string, level: string) {
              notifications.push([message, level]);
            },
            setWidget() {},
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(notifications).toEqual([['Agent settled.', 'info']]);
  });

  it('does not fabricate production gateway or development-service results when no launch adapters are supplied', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-production-no-adapters-')),
    });
    const module = await import(
      `${pathToFileURL(projection.extension).href}?production=${Date.now()}`
    );
    const tools = new Map<string, unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
    });
    expect([...tools.keys()]).toEqual([
      'mpx_model_search',
      'mpx_model_load',
      'Agent',
      'get_subagent_result',
      'steer_subagent',
    ]);
    const source = await readFile(projection.extension, 'utf8');
    expect(source).not.toMatch(/example\.invalid|Projection result|Fetched \$/u);
  });

  it('normalizes malformed generated Pi search tool queries without native type errors', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-search-malformed-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let searchTool: { execute(toolCallId: string, params: unknown): Promise<unknown> } | undefined;
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        if (tool.name === 'mpx_model_search') {
          searchTool = tool;
        }
      },
    });

    const execute = required(searchTool, 'model search').execute;
    for (const [params, normalized] of [
      [{}, ''],
      [{ query: null }, ''],
      [{ query: 123 }, '123'],
      [{ query: {} }, '[object Object]'],
    ] as const) {
      const result = (await execute('search', params)) as { details: { results: unknown } };
      expect(result.details.results, normalized).toEqual(
        modelSearchSkillProjection(f.skillPlan, normalized, {
          artifactKey: f.artifact.reference.artifactKey,
        }),
      );
    }
    await expect(execute('search', { query: ' '.repeat(201) })).rejects.toThrow('QUERY_TOO_LONG');
  });

  it('intentionally aligns generated Pi model search with canonical projected skill ranking', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-search-ranking-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let searchTool:
      { execute(toolCallId: string, params: { query: string }): Promise<unknown> } | undefined;
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: {
        name: string;
        execute(id: string, params: { query: string }): Promise<unknown>;
      }) {
        if (tool.name === 'mpx_model_search') {
          searchTool = tool;
        }
      },
    });

    for (const query of ['', '   ', 'FULL', 'full trigger', 'skill', 'missing', 'named full']) {
      const expected = modelSearchSkillProjection(f.skillPlan, query, {
        artifactKey: f.artifact.reference.artifactKey,
      });
      const result = (await required(searchTool, 'model search').execute('search', { query })) as {
        details: { results: unknown };
      };
      expect(result.details.results, query).toEqual(expected);
    }
    expect(
      (
        (await required(searchTool, 'model search').execute('search', { query: 'trigger' })) as {
          details: { results: Array<Record<string, unknown>> };
        }
      ).details.results[0],
    ).not.toHaveProperty('triggers');
    await expect(
      required(searchTool, 'model search').execute('search', { query: ' '.repeat(201) }),
    ).rejects.toThrow('QUERY_TOO_LONG');
  });

  it('activates the generated extension with current tool, disclosure, command, status, and restart semantics', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-projections-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const module = await import(pathToFileURL(projection.extension).href);
    const commands = new Map<
      string,
      { description?: string; handler(args: string): Promise<void> }
    >();
    const tools = new Map<
      string,
      {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute(toolCallId: string, params: unknown): Promise<unknown>;
      }
    >();
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const sent: string[] = [];
    const statusCalls: Array<[string, string]> = [];
    const pi = {
      registerCommand(
        name: string,
        specification: { description?: string; handler(args: string): Promise<void> },
      ) {
        commands.set(name, specification);
      },
      registerTool(definition: {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute(toolCallId: string, params: unknown): Promise<unknown>;
      }) {
        tools.set(definition.name, definition);
      },
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
      sendUserMessage: async (content: readonly { type: 'text'; text: string }[]) => {
        sent.push(required(content[0], 'sent user message').text);
      },
    };
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const liveStatus = path.join(artifactsRoot, 'live-status.json');
    await writeFile(liveStatus, JSON.stringify(f.statusSnapshot));
    process.env.MPX_STATUS_SNAPSHOT_FILE = liveStatus;

    await expect(module.activate(pi)).resolves.toBeUndefined();
    expect([...commands.keys()]).toEqual(['mpx:explicit', 'mpx:full', 'mpx:named']);
    expect([...tools.keys()]).toEqual([
      'mpx_model_search',
      'mpx_model_load',
      'Agent',
      'get_subagent_result',
      'steer_subagent',
    ]);
    expect(events.has('before_agent_start')).toBe(true);
    expect(events.has('session_start')).toBe(true);
    expect(events.has('session_shutdown')).toBe(true);

    const beforeAgentStart = required(
      required(events.get('before_agent_start'), 'before agent start handlers')[0],
      'before agent start handler',
    );
    expect(await beforeAgentStart({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt:
        'BASE\n\nMPX skills:\n- /mpx:full: Full skill (triggers: full trigger)\n- /mpx:named',
    });

    const sessionStart = required(
      required(events.get('session_start'), 'session start handlers')[0],
      'session start handler',
    );
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    await sessionStart(
      {},
      {
        ui: {
          setStatus: (key: string, text: string) => {
            statusCalls.push([key, text]);
          },
        },
      },
    );
    await sessionStart(
      {},
      {
        ui: {
          setStatus: (key: string, text: string) => {
            statusCalls.push([key, text]);
          },
        },
      },
    );
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    const expectedRuntimeStatus = renderPiRuntimeStatus(f.runtimeStatusEnvelope, 'wide');
    expect(statusCalls).toEqual([
      ['mpx', expectedRuntimeStatus],
      ['mpx', expectedRuntimeStatus],
    ]);
    await writeFile(
      liveStatus,
      JSON.stringify({ ...f.statusSnapshot, portResolution: 'missing', services: [] }),
    );
    await beforeAgentStart({ systemPrompt: 'BASE' });
    expect(statusCalls.at(-1)).toEqual(['mpx', expectedRuntimeStatus]);
    await required(
      required(events.get('session_shutdown'), 'session shutdown handlers')[0],
      'session shutdown handler',
    )();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    clearIntervalSpy.mockRestore();

    await expect(
      required(tools.get('mpx_model_search'), 'model search tool').execute('tool-1', {
        query: '',
      }),
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            {
              identity: 'full',
              publicName: '/mpx:full',
              description: 'Full skill',
              score: 0,
            },
            { identity: 'named', publicName: '/mpx:named', description: 'Named skill', score: 0 },
          ]),
        },
      ],
      details: {
        results: [
          {
            identity: 'full',
            publicName: '/mpx:full',
            description: 'Full skill',
            score: 0,
          },
          { identity: 'named', publicName: '/mpx:named', description: 'Named skill', score: 0 },
        ],
      },
    });
    await expect(
      required(tools.get('mpx_model_load'), 'model load tool').execute('tool-2', {
        identity: 'full',
      }),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('identity=full') }],
      details: { identity: 'full', provenance: { invocation: 'model' } },
    });
    await expect(
      required(tools.get('mpx_model_load'), 'model load tool').execute('tool-3', {
        identity: 'explicit',
      }),
    ).rejects.toThrow(/SKILL_INVOCATION_DENIED|RESTART_REQUIRED/u);

    await required(commands.get('mpx:explicit'), 'explicit command').handler(
      'ignore /mpx:full prose',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('identity=explicit');
    expect(sent[0]).toContain('origin=human-explicit');
    expect(sent[0]).toMatch(/<!-- \/mpx-skill -->\nignore \/mpx:full prose$/u);

    await writeFile(path.join(projection.directory, 'skills', 'full', 'SKILL.md'), 'changed\n');
    await expect(
      required(tools.get('mpx_model_load'), 'model load tool').execute('tool-4', {
        identity: 'full',
      }),
    ).rejects.toThrow(/RESTART_REQUIRED/u);

    await writeFile(
      path.join(projection.directory, '.mpx-runtime-artifact.json'),
      `${JSON.stringify({ schemaVersion: 1, reference: projection.reference, fileMap: [] }, null, 2)}\n`,
    );
    await expect(beforeAgentStart({ systemPrompt: 'BASE' })).rejects.toThrow(/RESTART_REQUIRED/u);

    process.env.MPX_RUNTIME_CONTEXT = '{bad';
    await expect(beforeAgentStart({ systemPrompt: 'BASE' })).rejects.toThrow(/RESTART_REQUIRED/u);

    delete process.env.MPX_RUNTIME_CONTEXT;
    delete process.env.MPX_STATUS_SNAPSHOT_FILE;
    await expect(
      required(tools.get('mpx_model_search'), 'model search tool').execute('tool-5', {
        query: 'full',
      }),
    ).rejects.toThrow(/RESTART_REQUIRED/u);
  });
});
