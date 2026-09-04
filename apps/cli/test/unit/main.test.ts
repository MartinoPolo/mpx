import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import { type BoundedProcessRunner } from '@mpx/executors';
import {
  DurableDevServiceManager,
  type ManagedProcess,
  type RuntimeAdapter,
} from '@mpx/dev-services';
import {
  PortService,
  RegistryStore,
  type PortPlatformAdapter,
  type WorktreeIdentity,
} from '@mpx/ports';
import {
  SessionService,
  SessionStore,
  type BranchRequestV1,
  type SessionRecordV1,
} from '@mpx/sessions';
import { createDefaultSbxDiagnostics } from '@mpx/application/node';
import { parseSbxLaunchPlanExportV1 } from '@mpx/runtime-contracts';
import { run } from '../../src/main.js';
import { captureIo } from '../../src/io.js';

const execFile = promisify(execFileCallback);

async function fixture(config: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-cli-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'mpxconfig.json'), config);
  return root;
}
async function directory(prefix = 'mpx-cli-known-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}
async function proofReleaseRoot(): Promise<string> {
  const root = await directory('mpx-proof-release-'),
    evidenceRoot = path.join(root, 'evidence'),
    source = fileURLToPath(new URL('../../../../evidence/', import.meta.url));
  await mkdir(evidenceRoot, { recursive: true });
  const executor = await readFile(path.join(source, 'executor-evidence.ts'));
  await writeFile(path.join(evidenceRoot, 'executor-evidence.ts'), executor);
  await writeFile(
    path.join(evidenceRoot, 'sbx-pin.json'),
    await readFile(path.join(source, 'sbx-pin.json')),
  );
  const inventory = JSON.parse(
    await readFile(path.join(source, 'runtime-tool-inventory.json'), 'utf8'),
  );
  inventory.executorEvidenceBindingSha256 = createHash('sha256').update(executor).digest('hex');
  await writeFile(
    path.join(evidenceRoot, 'runtime-tool-inventory.json'),
    JSON.stringify(inventory),
  );
  return root;
}
const valid = JSON.stringify({
  schemaVersion: 1,
  project: { id: 'sample/app' },
  repository: { provider: 'generic', remote: 'origin' },
});
const portPlatform: PortPlatformAdapter = {
  holdAvailablePorts: async () => ({ release: async () => undefined }),
  inspectListeners: async () => [],
  killProcess: async () => undefined,
  inspectProcess: async () => undefined,
};
class CliDevChild extends EventEmitter implements ManagedProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  fingerprint = 'start:900';
  closed: Promise<{ code: number | null; signal: string | null }>;
  resolve!: (exit: { code: number | null; signal: string | null }) => void;
  constructor(readonly pid = 900) {
    super();
    this.closed = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  onClose(listener: (exit: { code: number | null; signal: string | null }) => void) {
    this.on('close', listener);
  }
  exit() {
    const value = { code: 0, signal: null };
    this.emit('close', value);
    this.resolve(value);
  }
}
class CliDevRuntime implements RuntimeAdapter {
  kind = 'host' as const;
  child = new CliDevChild();
  tick = 0;
  now = () => new Date(1700000000000 + this.tick++).toISOString();
  sleep = async () => {};
  spawn = async () => this.child;
  probe = async () => true;
  inspect = async (pid: number) =>
    this.child.pid === pid ? { pid, fingerprint: this.child.fingerprint } : undefined;
  stop = async () => {
    this.child.exit();
  };
}

function mainPortService(stateRoot: string, cwd: string, repositoryId: string): PortService {
  const identity: WorktreeIdentity = {
    repositoryId,
    worktreeId: `${repositoryId}-main`,
    path: cwd,
    role: 'main',
    commonGitPath: path.join(cwd, '.git'),
    gitAdminPath: path.join(cwd, '.git'),
    head: 'abc',
  };
  return new PortService({
    store: new RegistryStore(stateRoot),
    git: { identify: async () => identity, list: async () => [identity] },
    platform: portPlatform,
  });
}
const managed = (projectId: string, preferred = 4173) =>
  JSON.stringify({
    schemaVersion: 1,
    project: { id: projectId },
    repository: { provider: 'generic', remote: 'origin' },
    development: {
      services: {
        app: {
          scope: 'checkout',
          port: { mode: 'managed', preferred },
          start: { type: 'package-script', script: 'dev' },
        },
      },
    },
  });
async function launchEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  return configuredLaunchEnv(cwd);
}
async function configuredLaunchEnv(
  cwd: string,
  options: {
    classifiedRoot?: string;
    identityDomain?: string;
    extraDomains?: Record<string, string[]>;
    domains?: Record<string, string[]>;
    contentScopes?: Record<string, { roots: string[]; skillPacks: string[] }>;
    docker?: boolean;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const appdata = await mkdtemp(path.join(tmpdir(), 'mpx-appdata-'));
  await mkdir(path.join(appdata, 'mpx'));
  const classifiedRoot = options.classifiedRoot ?? cwd,
    identityDomain = options.identityDomain ?? 'work';
  const domains = options.domains ?? { work: [classifiedRoot], ...options.extraDomains };
  const contentScopes = options.contentScopes ?? {
    work: { roots: [classifiedRoot], skillPacks: ['core'] },
  };
  await writeFile(
    path.join(appdata, 'mpx', 'config.json'),
    JSON.stringify({
      identities: {
        work: {
          domain: identityDomain,
          runtimeRoots: { claude: 'C:/native/claude-work', pi: 'C:/native/pi-work' },
          gitAuthorRoute: 'git-work',
          providerRoutes: { github: 'github-work' },
        },
      },
      domains,
      contentScopes,
      modes: {
        project: { resources: { 'selected-project': 'read-write' } },
        developer: {
          resources: { 'identity-domain': 'read-write', 'cloned-repositories': 'read-only' },
        },
        'personal-assistant': {
          resources: { 'assistant-input': 'read-write', 'assistant-output': 'read-write' },
        },
        'computer-control': {
          resources: {
            'computer-control-config': 'read-write',
            'computer-control-executable-settings': 'staged-write',
          },
        },
        unrestricted: { resources: { host: 'read-write' } },
      },
      skillPolicies: {
        clean: { skillExposure: { default: 'explicit-only' } },
        developer: { skillPacks: ['core'], skillExposure: { default: 'name-only' } },
      },
      presets: {
        'work-project': {
          identity: 'work',
          mode: 'project',
          skillPolicy: 'clean',
          contentScope: 'work',
          executor: 'docker',
          workspace: 'clone',
          networkPolicy: 'implementation',
        },
      },
      launchDefaults: {
        projects: { 'sample/app': { work: 'work-project' } },
        scopes: { work: { work: 'work-project' } },
      },
      networkPolicies: {
        open: { preset: 'allow-all' },
        implementation: { preset: 'balanced' },
        minimal: { preset: 'deny-all' },
      },
      executors: { host: {}, ...(options.docker === false ? {} : { docker: {} }) },
    }),
  );
  return { APPDATA: appdata };
}

describe('cli', () => {
  it('wires mpx dev lifecycle actions through the provider-neutral service', async () => {
    const cwd = await fixture(managed('sample/app', 4100)),
      io = captureIo();
    const calls: unknown[] = [];
    const devService = {
      start: async (request: unknown) => {
        calls.push(request);
        return { id: 'app', state: 'starting' };
      },
      status: (id?: string) => (id ? { id, state: 'ready' } : [{ id: 'app', state: 'ready' }]),
      logs: () => 'bounded',
      restart: async () => ({ id: 'app', state: 'starting' }),
      stop: async () => ({ id: 'app', state: 'stopped' }),
    };
    const portService = {
      resolve: async () => ({ lease: { worktreePath: cwd, services: { app: 4100 } } }),
    } as never;
    expect(
      await run(['--json', '--cwd', cwd, 'dev', 'start', '--id', 'app'], io, {
        env: {},
        portService,
        devService,
      } as never),
    ).toBe(0);
    expect(calls[0]).toMatchObject({
      id: 'app',
      cwd: path.resolve(cwd),
      ports: [4100],
      assignment: { worktreeRoot: path.resolve(cwd), ports: [4100] },
      executor: 'host',
    });
  });

  it('injects the complete coupled service URL map from the validated assignment', async () => {
    const config = JSON.stringify({
      schemaVersion: 1,
      project: { id: 'sample/coupled' },
      repository: { provider: 'generic', remote: 'origin' },
      tooling: { packageManager: 'pnpm' },
      development: {
        services: {
          web: {
            scope: 'checkout',
            port: { mode: 'managed', preferred: 4200 },
            environmentVariable: 'WEB_URL',
            protocol: 'http',
            start: { type: 'package-script', script: 'dev:web' },
          },
          api: {
            scope: 'checkout',
            port: { mode: 'managed', preferred: 4201 },
            environmentVariable: 'API_URL',
            protocol: 'https',
            start: { type: 'package-script', script: 'dev:api' },
          },
        },
      },
    });
    const cwd = await fixture(config),
      calls: unknown[] = [];
    const devService = {
      start: async (request: unknown) => {
        calls.push(request);
        return {};
      },
      status: async () => [],
      logs: async () => '',
      restart: async () => ({}),
      stop: async () => ({}),
    };
    const portService = { resolve: async () => ({ services: { web: 4210, api: 4211 } }) } as never;
    expect(
      await run(['--json', '--cwd', cwd, 'dev', 'start', '--id', 'web'], captureIo(), {
        env: {},
        portService,
        devService,
      } as never),
    ).toBe(0);
    expect(calls[0]).toMatchObject({
      executable: 'pnpm',
      args: ['run', 'dev:web'],
      environment: { WEB_URL: 'http://localhost:4210', API_URL: 'https://localhost:4211' },
    });
  });

  it('observes a service started by an earlier CLI invocation through durable state', async () => {
    const cwd = await fixture(managed('sample/cross', 4107)),
      stateRoot = await directory('mpx-cli-dev-state-'),
      runtime = new CliDevRuntime(),
      portService = { resolve: async () => ({ services: { app: 4107 } }) } as never;
    const first = Object.assign(new DurableDevServiceManager(runtime, stateRoot), {
      runtimeKind: 'host' as const,
    });
    expect(
      await run(['--json', '--cwd', cwd, 'dev', 'start', '--id', 'app'], captureIo(), {
        env: {},
        portService,
        devService: first,
      } as never),
    ).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    let data: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 20; attempt++) {
      const io = captureIo(),
        second = Object.assign(new DurableDevServiceManager(runtime, stateRoot), {
          runtimeKind: 'host' as const,
        });
      expect(
        await run(['--json', '--cwd', cwd, 'dev', 'status', '--id', 'app'], io, {
          env: {},
          devService: second,
        } as never),
      ).toBe(0);
      data = JSON.parse(io.out[0]!).data;
      if (data.state === 'ready') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(data).toMatchObject({ id: 'app', state: 'ready', pid: 900, fingerprint: 'start:900' });
  });

  it('reconciles a stale durable fingerprint during a later CLI invocation', async () => {
    const cwd = await fixture(managed('sample/stale', 4108)),
      stateRoot = await directory('mpx-cli-dev-stale-'),
      runtime = new CliDevRuntime(),
      portService = { resolve: async () => ({ services: { app: 4108 } }) } as never;
    await run(['--json', '--cwd', cwd, 'dev', 'start', '--id', 'app'], captureIo(), {
      env: {},
      portService,
      devService: Object.assign(new DurableDevServiceManager(runtime, stateRoot), {
        runtimeKind: 'host' as const,
      }),
    } as never);
    runtime.child.fingerprint = 'reused';
    const io = captureIo();
    await run(['--json', '--cwd', cwd, 'dev', 'status', '--id', 'app'], io, {
      env: {},
      devService: Object.assign(new DurableDevServiceManager(runtime, stateRoot), {
        runtimeKind: 'host' as const,
      }),
    } as never);
    expect(JSON.parse(io.out[0]!).data).toMatchObject({
      state: 'crashed',
      pid: null,
      lastError: expect.stringContaining('fingerprint'),
    });
  });

  it('surfaces readiness probe rejection as a crashed durable CLI status', async () => {
    const cwd = await fixture(managed('sample/probe', 4109)),
      stateRoot = await directory('mpx-cli-dev-probe-'),
      runtime = new CliDevRuntime();
    runtime.probe = async () => {
      throw new Error('probe rejected');
    };
    await run(['--json', '--cwd', cwd, 'dev', 'start', '--id', 'app'], captureIo(), {
      env: {},
      portService: { resolve: async () => ({ services: { app: 4109 } }) } as never,
      devService: Object.assign(new DurableDevServiceManager(runtime, stateRoot), {
        runtimeKind: 'host' as const,
      }),
    } as never);
    await new Promise((resolve) => setImmediate(resolve));
    let data: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 20; attempt++) {
      const io = captureIo();
      await run(['--json', '--cwd', cwd, 'dev', 'status', '--id', 'app'], io, {
        env: {},
        devService: Object.assign(new DurableDevServiceManager(runtime, stateRoot), {
          runtimeKind: 'host' as const,
        }),
      } as never);
      data = JSON.parse(io.out[0]!).data;
      if (data.lastError) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(data).toMatchObject({
      state: 'crashed',
      lastError: 'Readiness probe failed: probe rejected',
    });
  });

  it.each([
    ['status', [], undefined],
    ['status', ['--id', 'app'], 'app'],
    ['logs', ['--id', 'app', '--lines', '7'], 'app'],
    ['restart', ['--id', 'app'], 'app'],
    ['stop', ['--id', 'app'], 'app'],
  ])('wires dev %s with its action contract', async (action, options, id) => {
    const cwd = await fixture(managed('sample/actions', 4101)),
      io = captureIo(),
      calls: string[] = [];
    const devService = {
      status: async (actual?: string) => {
        calls.push(`status:${actual ?? 'all'}`);
        return [];
      },
      logs: async (actual: string, value?: { maxLines?: number }) => {
        calls.push(`logs:${actual}:${value?.maxLines}`);
        return 'log';
      },
      restart: async (actual: string) => {
        calls.push(`restart:${actual}`);
        return {};
      },
      stop: async (actual: string) => {
        calls.push(`stop:${actual}`);
        return {};
      },
      start: async () => ({}),
    };
    expect(
      await run(['--json', '--cwd', cwd, 'dev', action, ...options], io, {
        env: {},
        devService,
      } as never),
    ).toBe(0);
    expect(calls[0]).toContain(id ?? 'all');
  });

  it.each(['start', 'logs', 'restart', 'stop'])('requires --id for dev %s', async (action) => {
    const cwd = await fixture(managed('sample/ids', 4102)),
      io = captureIo();
    expect(
      await run(['--json', '--cwd', cwd, 'dev', action], io, {
        env: {},
        devService: {} as never,
      } as never),
    ).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
  });

  it('rejects dev log line bounds and rejects --lines on other actions', async () => {
    const cwd = await fixture(managed('sample/lines', 4103));
    for (const args of [
      ['logs', '--id', 'app', '--lines', '0'],
      ['logs', '--id', 'app', '--lines', '501'],
      ['status', '--lines', '2'],
    ]) {
      const io = captureIo();
      expect(
        await run(['--json', '--cwd', cwd, 'dev', ...args], io, {
          env: {},
          devService: {} as never,
        } as never),
      ).toBe(2);
      expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
    }
  });

  it('rejects malicious package script labels before port resolution or spawn', async () => {
    const config = JSON.stringify({
      schemaVersion: 1,
      project: { id: 'sample/evil' },
      repository: { provider: 'generic', remote: 'origin' },
      development: {
        services: {
          app: {
            scope: 'checkout',
            port: { mode: 'managed', preferred: 4104 },
            start: { type: 'package-script', script: 'dev && echo owned' },
          },
        },
      },
    });
    const cwd = await fixture(config),
      io = captureIo();
    let resolved = false,
      spawned = false;
    const portService = {
        resolve: async () => {
          resolved = true;
          return { services: { app: 4104 } };
        },
      } as never,
      devService = {
        start: async () => {
          spawned = true;
        },
        status: async () => [],
        logs: async () => '',
        restart: async () => ({}),
        stop: async () => ({}),
      };
    expect(
      await run(['--json', '--cwd', cwd, 'dev', 'start', '--id', 'app'], io, {
        env: {},
        portService,
        devService,
      } as never),
    ).toBe(1);
    expect(resolved).toBe(false);
    expect(spawned).toBe(false);
  });

  it('fails Docker dev commands closed unless a matching adapter is injected', async () => {
    const cwd = await fixture(managed('sample/docker', 4105)),
      io = captureIo();
    expect(
      await run(['--json', '--cwd', cwd, 'dev', 'status'], io, {
        env: { MPX_RUNTIME_CONTEXT: '{}', MPX_RUNTIME_EXECUTOR: 'docker' },
      } as never),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'DEV_EXECUTOR_UNSUPPORTED' },
    });
  });

  it('runs project-scoped launchers only from the canonical main owner root', async () => {
    const config = JSON.stringify({
      schemaVersion: 1,
      project: { id: 'sample/project' },
      repository: { provider: 'generic', remote: 'origin' },
      development: {
        services: {
          app: {
            scope: 'project',
            port: { mode: 'managed', preferred: 4106 },
            start: { type: 'package-script', script: 'dev' },
          },
        },
      },
    });
    const cwd = await fixture(config),
      owner = await directory('mpx-main-owner-'),
      calls: unknown[] = [];
    const service = {
      start: async (request: unknown) => {
        calls.push(request);
        return {};
      },
      status: async () => [],
      logs: async () => '',
      restart: async () => ({}),
      stop: async () => ({}),
    };
    expect(
      await run(['--json', '--cwd', cwd, 'dev', 'start', '--id', 'app'], captureIo(), {
        env: {},
        portService: {
          resolve: async () => ({ services: { app: 4106 }, ownerRoot: owner }),
        } as never,
        devService: service,
      } as never),
    ).toBe(0);
    expect(calls[0]).toMatchObject({
      cwd: path.resolve(owner),
      assignment: { worktreeRoot: path.resolve(owner) },
    });
  });

  it('reports external databases and test-only port consumers without spawning a launcher', async () => {
    for (const [type, extra] of [
      ['external', { kind: 'database' }],
      ['test-only', {}],
    ] as const) {
      const config = JSON.stringify({
        schemaVersion: 1,
        project: { id: `sample/${type}` },
        repository: { provider: 'generic', remote: 'origin' },
        development: {
          services: {
            port: {
              scope: 'project',
              port: { mode: 'fixed-shared', preferred: 5432 },
              start: { type, ...extra },
            },
          },
        },
      });
      const cwd = await fixture(config),
        io = captureIo();
      let spawned = false;
      const service = {
        start: async () => {
          spawned = true;
        },
        status: async () => [],
        logs: async () => '',
        restart: async () => ({}),
        stop: async () => ({}),
      };
      expect(
        await run(['--json', '--cwd', cwd, 'dev', 'start', '--id', 'port'], io, {
          env: {},
          portService: {
            resolve: async () => ({ services: { port: 5432 }, ownerRoot: cwd }),
          } as never,
          devService: service,
        } as never),
      ).toBe(0);
      expect(JSON.parse(io.out[0]!).data).toMatchObject({
        state: type,
        managed: false,
        port: 5432,
      });
      expect(spawned).toBe(false);
    }
  });

  it('emits exactly one JSON document', async () => {
    const cwd = await fixture(valid),
      io = captureIo();
    expect(await run(['--json', '--cwd', cwd, 'config', 'validate'], io, { env: {} })).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      apiVersion: 1,
      ok: true,
      data: { valid: true },
    });
  });

  it.each([
    ['show', 'malformed'],
    ['validate', 'malformed'],
    ['show', 'unreadable'],
    ['validate', 'unreadable'],
  ] as const)(
    'returns exact config %s success when optional APPDATA config is %s',
    async (action, state) => {
      const cwd = await fixture(valid),
        appdata = await directory('mpx-cli-optional-config-'),
        io = captureIo();
      await mkdir(path.join(appdata, 'mpx'));
      await writeFile(path.join(appdata, 'mpx', 'config.json'), '{malformed');
      const context =
        state === 'unreadable'
          ? {
              env: { APPDATA: appdata },
              accessFile: async () =>
                Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
            }
          : { env: { APPDATA: appdata } };

      expect(await run(['--json', '--cwd', cwd, 'config', action], io, context)).toBe(0);
      expect(io.err).toEqual([]);
      expect(io.out).toHaveLength(1);
      expect(JSON.parse(io.out[0]!)).toEqual({
        apiVersion: 1,
        ok: true,
        data:
          action === 'show'
            ? { path: path.join(cwd, 'mpxconfig.json'), config: JSON.parse(valid) }
            : { valid: true, path: path.join(cwd, 'mpxconfig.json') },
        warnings: [],
      });
    },
  );

  it('persists session mark relationship metadata through the real CLI parser', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const store = new SessionStore(await directory('mpx-cli-session-mark-'));
    const identity = { domain: 'work', name: 'work' };
    const record: SessionRecordV1 = {
      schemaVersion: 1,
      recordId: 'session-mark',
      runtimeQualifiedId: 'claude:session-mark',
      runtime: 'claude',
      identity,
      nativeBindingRef: 'binding',
      nativeSessionRef: { kind: 'native-id', value: 'session-mark' },
      launch: null,
      location: { cwd, project: null, repository: null, worktree: null },
      metadata: { title: null, model: null, effort: null },
      liveness: 'inactive',
      process: null,
      workflow: {
        status: 'unfinished',
        inbox: true,
        nextAction: null,
        priority: null,
        note: null,
        relatedIssue: null,
        relatedReview: null,
      },
      resume: { state: 'unknown', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
      timestamps: {
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        lastActivityAt: null,
      },
      lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    };
    await new SessionService(store).save(record);
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'session',
          'mark',
          'session-mark',
          'needs-review',
          '--related-issue',
          'GH-42',
          '--related-review',
          'PR-17',
        ],
        io,
        { env, sessionStore: store },
      ),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: true,
      data: { record: { workflow: { relatedIssue: 'GH-42', relatedReview: 'PR-17' } } },
    });
    await expect(new SessionService(store).show('session-mark')).resolves.toMatchObject({
      workflow: { relatedIssue: 'GH-42', relatedReview: 'PR-17' },
    });
  });

  it('hands factory branch service and terminal output through run while preserving envelopes and error precedence', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      localAppData = await directory('mpx-cli-branch-local-'),
      terminal = path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'),
      store = new SessionStore(await directory('mpx-cli-session-branch-')),
      now = '2025-01-01T00:00:00.000Z',
      identity = { domain: 'work', name: 'work' },
      rootDigest = 'b'.repeat(64);
    env.LOCALAPPDATA = localAppData;
    await mkdir(path.dirname(terminal), { recursive: true });
    await writeFile(terminal, 'test terminal');
    await store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: rootDigest,
      accountBindingRef: null,
      createdAt: now,
      updatedAt: now,
    });
    await new SessionService(store).save({
      schemaVersion: 1,
      recordId: 'branch-parent',
      runtimeQualifiedId: 'claude:branch-parent',
      runtime: 'claude',
      identity,
      nativeBindingRef: 'binding',
      nativeSessionRef: { kind: 'native-id', value: 'branch-parent' },
      launch: {
        launchKey: 'launch',
        descriptorDigest: 'a'.repeat(64),
        mode: 'locked',
        skillPolicy: 'clean',
        contentScope: 'work',
        executor: { kind: 'host' },
        workspace: 'direct',
        networkPolicy: 'restricted',
        grants: [],
        artifactKey: 'artifact',
        manifestKey: 'manifest',
      },
      location: { cwd, project: 'sample/app', repository: 'repository', worktree: null },
      metadata: { title: null, model: null, effort: null },
      liveness: 'inactive',
      process: null,
      workflow: {
        status: 'unfinished',
        inbox: true,
        nextAction: null,
        priority: null,
        note: null,
        relatedIssue: null,
        relatedReview: null,
      },
      resume: { state: 'unknown', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
      timestamps: { createdAt: now, updatedAt: now, lastActivityAt: null },
      lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    });
    const plan = vi.fn(async (input: BranchRequestV1) => ({
      schemaVersion: 1 as const,
      kind: 'session-branch-plan' as const,
      parent: input.parent,
      child: input.child,
      launchIdentity: input.launchIdentity,
      workspace: {
        ...input.workspace,
        selection: 'shared' as const,
        sharing: 'shared' as const,
        provision: 'current-checkout' as const,
        collisionDisclosure: input.files.collisionDisclosure,
      },
      files: input.files,
      terminal: input.terminal,
      confirmationDigest: 'factory-confirmation',
    }));
    const context = {
      env,
      sessionStore: store,
      sessionBranchService: { plan, apply: vi.fn() } as never,
    };
    const io = captureIo();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'session',
          'branch',
          'branch-parent',
          '--workspace',
          'shared',
          '--intent',
          'read',
          '--branch',
          'feature/child',
          '--terminal-tab',
          '--terminal-title',
          'Child',
          '--dry-run',
        ],
        io,
        context,
      ),
    ).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toEqual({
      apiVersion: 1,
      ok: true,
      data: await plan.mock.results[0]!.value,
      warnings: [],
    });
    expect(plan).toHaveBeenCalledWith({
      schemaVersion: 1,
      parent: {
        runtimeQualifiedId: 'claude:branch-parent',
        nativeSessionRef: { kind: 'native-id', value: 'branch-parent' },
      },
      child: {
        runtimeQualifiedId: `claude:pending-${sha256Canonical({ parent: 'claude:branch-parent', branch: 'feature/child' } as JsonValue).slice(0, 24)}`,
        runtime: 'claude',
      },
      launchIdentity: {
        identity,
        rootDigest,
        nativeBindingRef: 'binding',
        mode: 'locked',
        executor: 'host',
        skillPolicy: 'clean',
        contentScope: 'work',
        workspace: 'direct',
        networkPolicy: 'restricted',
        grants: [],
        artifactKey: 'artifact',
        manifestKey: 'manifest',
        launchKey: 'launch',
        descriptorDigest: 'a'.repeat(64),
      },
      workspace: {
        selection: 'shared',
        intent: 'read',
        cwd,
        projectRef: 'sample/app',
        repositoryRef: 'repository',
        worktreeRef: null,
        branch: 'feature/child',
      },
      files: {
        sharing: 'shared',
        collisionDisclosure: ['concurrent changes share the current checkout'],
        duplicateWriterRiskAcknowledged: false,
      },
      terminal: { enabled: true, executable: terminal, title: 'Child' },
    });

    const errorIo = captureIo();
    expect(
      await run(
        ['--json', '--cwd', cwd, 'session', 'branch', 'missing-parent', '--workspace', 'invalid'],
        errorIo,
        context,
      ),
    ).toBe(1);
    expect(JSON.parse(errorIo.out[0]!)).toMatchObject({
      apiVersion: 1,
      ok: false,
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  it('passes resurrection host authority without granting it to normal confirmed resumes', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      store = new SessionStore(await directory('mpx-cli-session-resume-')),
      now = '2025-01-01T00:00:00.000Z',
      identity = { domain: 'work', name: 'work' },
      rootDigest = 'b'.repeat(64);
    await store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: rootDigest,
      accountBindingRef: null,
      createdAt: now,
      updatedAt: now,
    });
    await new SessionService(store).save({
      schemaVersion: 1,
      recordId: 'resume-compatible',
      runtimeQualifiedId: 'claude:resume-compatible',
      runtime: 'claude',
      identity,
      nativeBindingRef: 'binding',
      nativeSessionRef: { kind: 'native-id', value: 'resume-compatible' },
      launch: {
        launchKey: 'old-launch',
        descriptorDigest: 'a'.repeat(64),
        mode: 'interactive',
        skillPolicy: 'standard',
        contentScope: 'work',
        executor: { kind: 'host' },
        workspace: 'direct',
        networkPolicy: 'restricted',
        grants: [],
        artifactKey: 'artifact',
        manifestKey: 'manifest',
      },
      location: { cwd, project: 'sample/app', repository: 'sample/repository', worktree: null },
      metadata: { title: null, model: null, effort: null },
      liveness: 'inactive',
      process: null,
      workflow: {
        status: 'unfinished',
        inbox: true,
        nextAction: null,
        priority: null,
        note: null,
        relatedIssue: null,
        relatedReview: null,
      },
      resume: { state: 'unknown', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
      timestamps: { createdAt: now, updatedAt: now, lastActivityAt: null },
      lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    });
    const executeResume = vi.fn(async (resumePlan, _execution) => ({
      exitCode: 0,
      launchKey: resumePlan.launch.launchKey,
    }));
    const context = {
      env,
      sessionStore: store,
      sessionDiscoveries: async () => [],
      sessionProcessInspector: { inspect: async () => ({ status: 'absent' as const }) },
      sessionResumeDependencies: async () => ({
        resolveConfiguredRoot: async () => ({
          root: 'C:/native/claude-work',
          canonicalRootDigest: rootDigest,
          identity,
          runtime: 'claude' as const,
        }),
        verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
      }),
      sessionResumeExecutor: executeResume,
    };
    const previewIo = captureIo();
    expect(
      await run(
        ['--json', '--cwd', cwd, 'session', 'resume', 'resume-compatible', '--dry-run'],
        previewIo,
        context,
      ),
    ).toBe(0);
    const preview = JSON.parse(previewIo.out[0]!).data;
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'session',
          'resume',
          'resume-compatible',
          '--confirm-plan',
          preview.confirmationDigest,
        ],
        captureIo(),
        context,
      ),
    ).toBe(0);
    expect(executeResume).toHaveBeenCalledWith(expect.any(Object), {});
    executeResume.mockClear();

    const executeIo = captureIo();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'session',
          'resume',
          'resume-compatible',
          '--approve-resurrection',
        ],
        executeIo,
        context,
      ),
    ).toBe(0);
    expect(JSON.parse(executeIo.out[0]!)).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        kind: 'session-resume',
        result: { exitCode: 0, launchKey: 'old-launch' },
      },
      warnings: [],
    });
    expect(executeResume).toHaveBeenCalledOnce();
    expect(executeResume).toHaveBeenCalledWith(expect.any(Object), { approveHost: true });
  });

  it('hands confirmed resume to Node production composition before lazy status and state factories', async () => {
    const cwd = await fixture(valid),
      configuredEnv = await configuredLaunchEnv(cwd),
      env = { ...configuredEnv, LOCALAPPDATA: undefined },
      store = new SessionStore(await directory('mpx-cli-node-resume-')),
      now = '2025-01-01T00:00:00.000Z',
      identity = { domain: 'work', name: 'work' },
      rootDigest = 'b'.repeat(64);
    await store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: rootDigest,
      accountBindingRef: null,
      createdAt: now,
      updatedAt: now,
    });
    await new SessionService(store).save({
      schemaVersion: 1,
      recordId: 'resume-node-composition',
      runtimeQualifiedId: 'claude:resume-node-composition',
      runtime: 'claude',
      identity,
      nativeBindingRef: 'binding',
      nativeSessionRef: { kind: 'native-id', value: 'resume-node-composition' },
      launch: {
        launchKey: 'old-launch',
        descriptorDigest: 'a'.repeat(64),
        mode: 'interactive',
        skillPolicy: 'standard',
        contentScope: 'work',
        executor: { kind: 'docker' },
        workspace: 'direct',
        networkPolicy: 'restricted',
        grants: [],
        artifactKey: 'artifact',
        manifestKey: 'manifest',
      },
      location: { cwd, project: 'sample/app', repository: 'sample/repository', worktree: null },
      metadata: { title: null, model: null, effort: null },
      liveness: 'inactive',
      process: null,
      workflow: {
        status: 'unfinished',
        inbox: true,
        nextAction: null,
        priority: null,
        note: null,
        relatedIssue: null,
        relatedReview: null,
      },
      resume: { state: 'unknown', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
      timestamps: { createdAt: now, updatedAt: now, lastActivityAt: null },
      lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    });
    const admission = vi.fn(async () => ({
      admitted: false as const,
      code: 'F2_ADMISSION_DENIED' as const,
      hostFallback: false as const,
      recreate: { required: true as const, reasons: ['proof unavailable'] },
    }));
    const statusProviderFactory = vi.fn(() => {
      throw new Error('status composition must remain behind Docker admission');
    });
    const context = {
      env,
      sessionStore: store,
      sessionDiscoveries: async () => [],
      sessionProcessInspector: { inspect: async () => ({ status: 'absent' as const }) },
      sessionResumeDependencies: async () => ({
        resolveConfiguredRoot: async () => ({
          root: 'C:/native/claude-work',
          canonicalRootDigest: rootDigest,
          identity,
          runtime: 'claude' as const,
        }),
        verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
      }),
      sessionDockerResumeAdmission: admission,
      portService: {} as never,
      statusProviderFactory,
    };
    const previewIo = captureIo();
    expect(
      await run(
        ['--json', '--cwd', cwd, 'session', 'resume', 'resume-node-composition', '--dry-run'],
        previewIo,
        context,
      ),
    ).toBe(0);
    const preview = JSON.parse(previewIo.out[0]!).data;
    const executeIo = captureIo();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'session',
          'resume',
          'resume-node-composition',
          '--confirm-plan',
          preview.confirmationDigest,
        ],
        executeIo,
        context,
      ),
    ).toBe(1);
    expect(JSON.parse(executeIo.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'SESSION_RESUME_F2_ADMISSION_DENIED' },
    });
    expect(admission).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeQualifiedId: 'claude:resume-node-composition',
        nativeBindingRef: 'binding',
        nativeSessionRef: { kind: 'native-id', value: 'resume-node-composition' },
        cwd,
        launch: expect.objectContaining({ executor: { kind: 'docker' } }),
      }),
    );
    expect(statusProviderFactory).not.toHaveBeenCalled();
  });

  it('passes an injected Pi process inspector through the real session reconcile path', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const store = new SessionStore(await directory('mpx-cli-session-reconcile-'));
    const identity = { domain: 'work', name: 'work' };
    const record: SessionRecordV1 = {
      schemaVersion: 1,
      recordId: 'pi-active',
      runtimeQualifiedId: 'pi:active',
      runtime: 'pi',
      identity,
      nativeBindingRef: 'binding',
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/active.jsonl' },
      launch: null,
      location: { cwd, project: null, repository: null, worktree: null },
      metadata: { title: null, model: null, effort: null },
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
      workflow: {
        status: 'unfinished',
        inbox: true,
        nextAction: null,
        priority: null,
        note: null,
        relatedIssue: null,
        relatedReview: null,
      },
      resume: { state: 'unknown', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
      timestamps: {
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        lastActivityAt: null,
      },
      lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    };
    await new SessionService(store).save(record);
    expect(
      await run(['--json', '--cwd', cwd, 'session', 'reconcile'], io, {
        env,
        sessionStore: store,
        sessionDiscoveries: async () => [],
        sessionProcessInspector: { inspect: async () => ({ status: 'absent' }) },
      }),
    ).toBe(0);
    await expect(new SessionService(store).show('pi:active')).resolves.toMatchObject({
      liveness: 'inactive',
      process: null,
    });
  });

  it('binds explicit --cwd into production worktree removal in-use detection', async () => {
    const localAppData = await directory('mpx-cli-state-'),
      target = await directory('mpx-cli-target-'),
      inside = path.join(target, 'packages', 'app'),
      io = captureIo();
    await mkdir(inside, { recursive: true });
    let operationCwd = '';
    const unavailable = async () => {
      throw new Error('unexpected');
    };
    const portService = {
      ensure: unavailable,
      resolve: unavailable,
      list: unavailable,
      inspect: unavailable,
      kill: unavailable,
      release: unavailable,
      reconcile: unavailable,
      rebuild: unavailable,
      captureReleaseIdentity: unavailable,
      releaseLinkedAfterRemoval: unavailable,
      resolveOrphan: unavailable,
    } as never;
    const context = {
      env: { LOCALAPPDATA: localAppData },
      portService,
      worktreeServiceFactory: (_root: string, _ports: unknown, cwd: string) => {
        operationCwd = cwd;
        return {
          create: unavailable,
          list: unavailable,
          select: unavailable,
          status: unavailable,
          prepare: unavailable,
          cancel: unavailable,
          reconcile: unavailable,
          remove: async () => {
            if (operationCwd.startsWith(target)) {
              throw new MpxError({ code: 'WORKTREE_REMOVE_IN_USE', message: 'in use' });
            }
            return { status: 'removed' };
          },
        } as never;
      },
    };
    expect(await run(['--json', '--cwd', inside, 'worktree', 'remove', target], io, context)).toBe(
      1,
    );
    expect(operationCwd).toBe(path.resolve(inside));
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'WORKTREE_REMOVE_IN_USE' },
    });
  });

  it('init is a no-write plan', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-init-')),
      io = captureIo();
    expect(await run(['--json', '--cwd', cwd, 'init'], io, { env: {} })).toBe(0);
    await expect(readFile(path.join(cwd, 'mpxconfig.json'), 'utf8')).rejects.toThrow();
    expect(JSON.parse(io.out[0]!).data.plan.actions[0].type).toBe('create');
  });

  it('does not publish a manifest when the port state service is unavailable', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-init-no-state-')),
      io = captureIo();
    expect(await run(['--json', '--cwd', cwd, 'init', '--confirm'], io, { env: {} })).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'STATE_ROOT_UNAVAILABLE' },
    });
    expect(await readdir(cwd)).toEqual([]);
  });

  it('confirmed init creates a valid suggested manifest before reserving the main worktree', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-init-create-')),
      stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-init-create-state-')),
      io = captureIo();
    await mkdir(path.join(cwd, '.git'));
    expect(
      await run(['--json', '--cwd', cwd, 'init', '--confirm'], io, {
        env: {},
        portService: mainPortService(stateRoot, cwd, 'created-repo'),
      }),
      io.out.join('\n'),
    ).toBe(0);
    expect(JSON.parse(await readFile(path.join(cwd, 'mpxconfig.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      project: { id: `REPLACE_ME/${path.basename(cwd)}` },
    });
    expect(JSON.parse(io.out[0]!).data.lease).toMatchObject({ role: 'main', slot: 0 });
  });

  it('rolls back only the manifest created by this init when port initialization fails', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-init-port-failure-')),
      io = captureIo();
    const portService = {
      ensure: async () => {
        throw new MpxError({ code: 'PORT_CONFLICT', message: 'conflict' });
      },
    } as never;
    expect(
      await run(['--json', '--cwd', cwd, 'init', '--confirm'], io, { env: {}, portService }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'PORT_CONFLICT' } });
    expect(await readdir(cwd)).toEqual([]);
  });

  it('preserves a preexisting manifest when port initialization fails', async () => {
    const cwd = await fixture(valid),
      before = await readFile(path.join(cwd, 'mpxconfig.json'), 'utf8'),
      io = captureIo();
    const portService = {
      ensure: async () => {
        throw new MpxError({ code: 'PORT_CONFLICT', message: 'conflict' });
      },
    } as never;
    expect(
      await run(['--json', '--cwd', cwd, 'init', '--confirm'], io, { env: {}, portService }),
    ).toBe(1);
    expect(await readFile(path.join(cwd, 'mpxconfig.json'), 'utf8')).toBe(before);
  });

  it('preserves a replacement manifest when port initialization fails', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-init-replacement-')),
      manifestPath = path.join(cwd, 'mpxconfig.json'),
      io = captureIo();
    const portService = {
      ensure: async () => {
        await unlink(manifestPath);
        await mkdir(manifestPath);
        throw new MpxError({ code: 'PORT_CONFLICT', message: 'conflict' });
      },
    } as never;
    expect(
      await run(['--json', '--cwd', cwd, 'init', '--confirm'], io, { env: {}, portService }),
    ).toBe(1);
    expect(await readdir(manifestPath)).toEqual([]);
  });

  it('reports projection and exact lease compensation failures structurally and sanitized', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-init-dual-failure-')),
      io = captureIo();
    const portService = {
      ensure: async () => {
        throw new MpxError({
          code: 'PORT_ENSURE_COMPENSATION_FAILED',
          message: 'sensitive dual failure',
          details: {
            originalCode: 'PROJECTION_FAILED',
            compensationCode: 'PORT_COMPENSATION_CONFLICT',
          },
        });
      },
    } as never;
    expect(
      await run(['--json', '--cwd', cwd, 'init', '--confirm'], io, { env: {}, portService }),
    ).toBe(1);
    const output = io.out[0]!;
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: {
        code: 'INIT_COMPENSATION_FAILED',
        details: {
          originalCode: 'PROJECTION_FAILED',
          compensationCode: 'PORT_COMPENSATION_CONFLICT',
        },
      },
    });
    expect(output).not.toContain('sensitive dual failure');
  });

  it('confirmed init reserves slot zero and materializes the main projection', async () => {
    const cwd = await fixture(managed('confirmed/app')),
      stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-init-state-')),
      io = captureIo();
    const service = mainPortService(stateRoot, cwd, 'confirmed-repo');
    expect(
      await run(['--json', '--cwd', cwd, 'init', '--confirm'], io, {
        env: {},
        portService: service,
      }),
      io.out.join('\n'),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!).data.lease).toMatchObject({
      role: 'main',
      slot: 0,
      services: { app: 4173 },
    });
    expect(
      JSON.parse(await readFile(path.join(cwd, '.worktree-ports.json'), 'utf8')),
    ).toMatchObject({ schemaVersion: 1, projectId: 'confirmed/app', services: { app: 4173 } });
  });

  it("confirmed init rejects another project's exclusive preferred-port conflict", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-init-conflict-')),
      first = await fixture(managed('first/app')),
      second = await fixture(managed('second/app'));
    expect(
      await run(['--json', '--cwd', first, 'init', '--confirm'], captureIo(), {
        env: {},
        portService: mainPortService(stateRoot, first, 'repo-first'),
      }),
    ).toBe(0);
    const io = captureIo();
    expect(
      await run(['--json', '--cwd', second, 'init', '--confirm'], io, {
        env: {},
        portService: mainPortService(stateRoot, second, 'repo-second'),
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'PORT_CONFLICT' } });
    await expect(readFile(path.join(second, '.worktree-ports.json'), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('repeated confirmed init leaves manifest, registry, and projection byte-identical', async () => {
    const cwd = await fixture(managed('stable/app')),
      stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-init-stable-')),
      service = mainPortService(stateRoot, cwd, 'stable-repo');
    expect(
      await run(['--json', '--cwd', cwd, 'init', '--confirm'], captureIo(), {
        env: {},
        portService: service,
      }),
    ).toBe(0);
    const files = [
      path.join(cwd, 'mpxconfig.json'),
      path.join(cwd, '.worktree-ports.json'),
      path.join(stateRoot, 'ports-registry.json'),
    ];
    const before = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    expect(
      await run(['--json', '--cwd', cwd, 'init', '--confirm'], captureIo(), {
        env: {},
        portService: service,
      }),
    ).toBe(0);
    expect(await Promise.all(files.map((file) => readFile(file, 'utf8')))).toEqual(before);
  });

  it('normalizes malformed project config JSON to a privacy-safe CONFIG_INVALID envelope', async () => {
    const cwd = await fixture('{"secret":"do-not-print",'),
      io = captureIo();
    expect(await run(['--json', '--cwd', cwd, 'config', 'validate'], io, { env: {} })).toBe(1);
    const text = io.out.join(''),
      body = JSON.parse(text);
    expect(io.out).toHaveLength(1);
    expect(body).toMatchObject({
      apiVersion: 1,
      ok: false,
      error: { code: 'CONFIG_INVALID', message: 'Configuration is invalid.', retryable: false },
      warnings: [],
    });
    expect(body.error.details).toBeUndefined();
    expect(text).not.toContain('do-not-print');
    expect(text).not.toContain('Expected');
    expect(text).not.toContain('position');
  });

  it('explains the selected provider by role', async () => {
    const cwd = await fixture(
        JSON.stringify({
          schemaVersion: 1,
          project: { id: 'sample/app' },
          repository: { provider: 'github', remote: 'origin' },
          issues: { provider: 'none' },
        }),
      ),
      io = captureIo();
    expect(
      await run(['--json', '--cwd', cwd, 'provider', 'explain', 'repository'], io, { env: {} }),
    ).toBe(0);
    const data = JSON.parse(io.out[0]!).data;
    expect(data).toMatchObject({ role: 'repository', provider: 'github', adapter: 'gh' });
    expect(data.capabilities.every((capability: string) => !capability.startsWith('issue.'))).toBe(
      true,
    );
  });

  it('uses exit two for usage errors', async () => {
    const io = captureIo();
    expect(await run(['--json', 'unknown'], io, { env: {} })).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
  });

  it('fails skill commands closed when launch identity is omitted', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        ['--json', '--cwd', cwd, 'skill', 'list', '--runtime', 'pi', '--skill-policy', 'clean'],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'IDENTITY_REQUIRED' },
    });
  });

  it('rejects skill resolution for an identity absent from strict user config', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'list',
          '--runtime',
          'pi',
          '--identity',
          'missing',
          '--skill-policy',
          'clean',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'IDENTITY_UNKNOWN' },
    });
  });

  it('preserves unknown identity precedence before later skill syntax validation', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    expect(
      await run(['--json', '--cwd', cwd, 'skill', 'list', '--identity', 'missing'], io, { env }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'IDENTITY_UNKNOWN' },
    });
  });

  it('requires an explicit runtime for every skill resolution', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        ['--json', '--cwd', cwd, 'skill', 'list', '--identity', 'work', '--skill-policy', 'clean'],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'SKILL_RUNTIME_REQUIRED' },
    });
  });

  it('requires an explicit configured skill policy for every skill resolution', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        ['--json', '--cwd', cwd, 'skill', 'list', '--identity', 'work', '--runtime', 'pi'],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'SKILL_POLICY_REQUIRED' },
    });
  });

  it('preserves unknown skill policy precedence before action argument validation', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'list',
          'unexpected',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'missing',
        ],
        io,
        { env },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'SKILL_POLICY_UNKNOWN' },
    });
  });

  it('completes explicit-only skills for humans without descriptions', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'complete',
          '/mpx:r',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'clean',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    const text = io.out[0]!;
    expect(JSON.parse(text).data).toMatchObject({ completions: ['/mpx:review'] });
    expect(text).not.toContain('Reviews implementation');
  });

  it('constructs a launch-bound skill artifact from strict user-local inputs', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'list',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'clean',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    const text = io.out[0]!,
      data = JSON.parse(text).data;
    expect(data).toMatchObject({
      artifact: {
        schemaVersion: 4,
        identity: 'work',
        skillPolicy: 'clean',
        runtime: 'pi',
        contentScope: 'work',
        manifestKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      manifest: { schemaVersion: 4, binding: { repositoryId: 'sample/app' } },
      skills: [{ identity: 'review', exposure: 'explicit-only' }],
    });
    expect(data.artifact.artifactKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(text).not.toContain('C:/native');
  });

  it('includes project skills in advertised launch-bound resolution', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const directory = path.join(cwd, '.agents', 'skills', 'local');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: local\ndescription: Local project behavior\nmetadata:\n  mpx:\n    projectExposure: full\n---\nLOCAL BODY\n',
    );
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'list',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'clean',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!).data.skills).toEqual(
      expect.arrayContaining([
        { identity: 'local', publicName: '/local', exposure: 'explicit-only' },
      ]),
    );
  });

  it('lists skills in a known non-project directory with a null projectId', async () => {
    const cwd = await directory(),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'list',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'clean',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    const data = JSON.parse(io.out[0]!).data;
    expect(data).toMatchObject({
      artifact: { identity: 'work', contentScope: 'work', runtime: 'pi', projectId: null },
      skills: [{ identity: 'review', exposure: 'explicit-only' }],
    });
  });

  it('binds the selected validated skill policy into artifact identity and disclosure', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    const cleanIo = captureIo(),
      developerIo = captureIo();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'list',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'clean',
        ],
        cleanIo,
        { env, catalogRoot },
      ),
    ).toBe(0);
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'list',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'developer',
        ],
        developerIo,
        { env, catalogRoot },
      ),
    ).toBe(0);
    const clean = JSON.parse(cleanIo.out[0]!).data,
      developer = JSON.parse(developerIo.out[0]!).data;
    expect(clean.skills[0].exposure).toBe('explicit-only');
    expect(developer.skills[0].exposure).toBe('name-only');
    expect(clean.artifact.artifactKey).not.toBe(developer.artifact.artifactKey);
    expect(clean.artifact.manifestKey).not.toBe(developer.artifact.manifestKey);
  });

  it('constructs an identity-bound non-project skill artifact for a known cross-domain assistant cwd', async () => {
    const cwd = await directory('mpx-assistant-input-'),
      workRoot = await directory('mpx-work-root-');
    const env = await configuredLaunchEnv(cwd, {
        domains: { work: [workRoot], 'assistant-input': [cwd] },
        contentScopes: {
          work: { roots: [workRoot], skillPacks: ['core'] },
          'assistant-input': { roots: [cwd], skillPacks: ['core'] },
        },
      }),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'list',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'clean',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toMatchObject({
      artifact: {
        identity: 'work',
        contentScope: 'assistant-input',
        runtime: 'pi',
        projectId: null,
      },
      skills: [{ identity: 'review', exposure: 'explicit-only' }],
    });
  });

  it('surfaces invalid user-config interpolation as a sanitized CONFIG_INVALID envelope', async () => {
    const appdata = await mkdtemp(path.join(tmpdir(), 'mpx-appdata-'));
    await mkdir(path.join(appdata, 'mpx'));
    await writeFile(
      path.join(appdata, 'mpx', 'config.json'),
      JSON.stringify({
        identities: {},
        domains: { work: ['${MPX_WORK}/nested'] },
        contentScopes: {},
        modes: {},
        skillPolicies: {},
        presets: {},
        executors: { host: {} },
      }),
    );
    const io = captureIo();
    expect(
      await run(['--json', 'identity', 'list'], io, {
        env: { APPDATA: appdata, MPX_WORK: 'C:/private/work' },
      }),
    ).toBe(1);
    const text = io.out[0]!;
    expect(JSON.parse(text)).toEqual({
      apiVersion: 1,
      ok: false,
      error: {
        code: 'CONFIG_INVALID',
        message: 'Configuration is invalid.',
        retryable: false,
        details: { errors: [{ pointer: '/domains/work/0', keyword: 'semantic' }] },
      },
      warnings: [],
    });
    expect(text).not.toContain('private');
    expect(text).not.toContain('MPX_WORK');
    expect(text).not.toContain(appdata);
  });

  it('normalizes malformed user config JSON to a privacy-safe CONFIG_INVALID envelope', async () => {
    const appdata = await mkdtemp(path.join(tmpdir(), 'mpx-appdata-'));
    await mkdir(path.join(appdata, 'mpx'));
    await writeFile(path.join(appdata, 'mpx', 'config.json'), '{"secret":"do-not-print",');
    const io = captureIo();
    expect(await run(['--json', 'identity', 'list'], io, { env: { APPDATA: appdata } })).toBe(1);
    const text = io.out[0]!,
      body = JSON.parse(text);
    expect(body).toMatchObject({
      apiVersion: 1,
      ok: false,
      error: { code: 'CONFIG_INVALID', message: 'Configuration is invalid.', retryable: false },
      warnings: [],
    });
    expect(body.error.details).toBeUndefined();
    expect(text).not.toContain('do-not-print');
    expect(text).not.toContain('Expected');
    expect(text).not.toContain('position');
  });

  it('fails optional user-config reads with USER_CONFIG_UNREADABLE instead of falling back to empty config', async () => {
    const cwd = await fixture(valid),
      io = captureIo();
    const appdata = await mkdtemp(path.join(tmpdir(), 'mpx-appdata-'));
    const accessFile = async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    expect(
      await run(['--json', '--cwd', cwd, 'config', 'resolve'], io, {
        env: { APPDATA: appdata },
        accessFile,
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'USER_CONFIG_UNREADABLE', details: { errno: 'EACCES' } },
    });
  });

  it('fails required user-config reads with USER_CONFIG_UNREADABLE instead of reporting missing config', async () => {
    const io = captureIo();
    const appdata = await mkdtemp(path.join(tmpdir(), 'mpx-appdata-'));
    const accessFile = async () => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    };
    expect(
      await run(['--json', 'identity', 'list'], io, { env: { APPDATA: appdata }, accessFile }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'USER_CONFIG_UNREADABLE', details: { errno: 'EPERM' } },
    });
  });

  it('lists identities deterministically without native runtime roots', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    expect(await run(['--json', 'identity', 'list'], io, { env })).toBe(0);
    const text = io.out[0]!,
      body = JSON.parse(text);
    expect(body).toMatchObject({
      apiVersion: 1,
      ok: true,
      data: {
        schemaVersion: 1,
        kind: 'identity',
        items: [
          {
            name: 'work',
            domain: 'work',
            gitAuthorRoute: 'git-work',
            providerRoutes: { github: 'github-work' },
          },
        ],
      },
    });
    expect(text).not.toContain('runtimeRoots');
    expect(text).not.toContain('C:/native');
  });

  it.each([
    ['mode', 'project'],
    ['skill-policy', 'clean'],
    ['preset', 'work-project'],
  ])('lists and shows read-only %s contracts in versioned envelopes', async (group, name) => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      listIo = captureIo(),
      showIo = captureIo();
    expect(await run(['--json', group, 'list'], listIo, { env })).toBe(0);
    expect(await run(['--json', group, 'show', name], showIo, { env })).toBe(0);
    expect(JSON.parse(listIo.out[0]!)).toMatchObject({
      apiVersion: 1,
      ok: true,
      data: { schemaVersion: 1, kind: group, items: expect.any(Array) },
    });
    expect(JSON.parse(showIo.out[0]!)).toMatchObject({
      apiVersion: 1,
      ok: true,
      data: { schemaVersion: 1, kind: group, item: { name } },
    });
  });

  it('explains candidates for every sorted identity without inferring one or exposing roots', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd);
    const file = path.join(env.APPDATA!, 'mpx', 'config.json'),
      config = JSON.parse(await readFile(file, 'utf8'));
    config.identities.alpha = {
      ...config.identities.work,
      runtimeRoots: { claude: 'C:/native/alpha-claude', pi: 'C:/native/alpha-pi' },
    };
    config.presets['alpha-project'] = { ...config.presets['work-project'], identity: 'alpha' };
    config.launchDefaults.projects['sample/app'].alpha = 'alpha-project';
    config.launchDefaults.scopes.work.alpha = 'alpha-project';
    await writeFile(file, JSON.stringify(config));
    const io = captureIo();
    expect(await run(['--json', '--cwd', cwd, 'launch', 'explain'], io, { env })).toBe(0);
    const text = io.out[0]!,
      data = JSON.parse(text).data;
    expect(data).toMatchObject({
      schemaVersion: 1,
      identity: null,
      runtime: null,
      candidates: [{ identity: 'alpha' }, { identity: 'work' }],
    });
    expect(text).not.toContain('runtimeRoots');
    expect(text).not.toContain('C:/native');
    expect(text).not.toContain(cwd);
  });

  it('accepts optional runtime and direct workspace/network axes in identity explanation', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--identity',
          'work',
          '--workspace',
          'host-worktree',
          '--network-policy',
          'minimal',
        ],
        io,
        { env },
      ),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toEqual({
      schemaVersion: 1,
      runtime: null,
      identity: { name: 'work', domain: 'work' },
      selection: {
        mode: { name: 'project' },
        skillPolicy: { name: 'clean' },
        contentScope: { name: 'work' },
        executor: 'docker',
        workspace: 'host-worktree',
        networkPolicy: { name: 'minimal' },
        preset: 'work-project',
        provenance: {
          runtime: 'explicit',
          identity: 'explicit',
          mode: 'user-project',
          skillPolicy: 'user-project',
          contentScope: 'user-project',
          executor: 'user-project',
          workspace: 'explicit',
          networkPolicy: 'explicit',
        },
        cwdClassification: { domain: 'work', contentScope: 'work' },
      },
    });
  });

  it('rejects the obsolete launch resolve surface', async () => {
    const io = captureIo();
    expect(await run(['--json', 'launch', 'resolve', 'pi'], io, { env: {} })).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
  });

  it('reports an unexpected internal source error only through the debug boundary while keeping JSON output private', async () => {
    const cwd = await fixture(valid),
      env: NodeJS.ProcessEnv = {
        ...(await configuredLaunchEnv(cwd)),
        LOCALAPPDATA: await directory('mpx-plan-debug-state-'),
        MPX_RELEASE_ROOT: await proofReleaseRoot(),
      },
      io = captureIo(),
      errors: unknown[] = [];
    const privateCatalogRoot = path.join(await directory('mpx-private-catalog-'), 'missing');
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'sbx-plan-export',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'project',
          '--skill-policy',
          'clean',
          '--network-policy',
          'minimal',
        ],
        io,
        { env, catalogRoot: privateCatalogRoot, onInternalError: (error) => errors.push(error) },
      ),
    ).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'Command failed.' },
    });
    expect(io.out[0]).not.toContain(privateCatalogRoot);
    expect(io.out[0]).not.toContain(cwd);
  });

  it('exports from the bundled CLI in a realistic main Git checkout with release-owned catalog and evidence', async () => {
    const checkout = fileURLToPath(new URL('../../../..', import.meta.url)),
      bundle = path.join(checkout, 'bin', 'mpx.mjs'),
      env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(await configuredLaunchEnv(checkout)),
        LOCALAPPDATA: await directory('mpx-bundled-plan-state-'),
      };
    delete env.MPX_RELEASE_ROOT;
    delete env.MPX_DEV_MODE;
    const before = {
      checkout: await readdir(checkout),
      state: await readdir(env.LOCALAPPDATA!),
      appdata: await readdir(env.APPDATA!),
    };
    const result = await execFile(
      process.execPath,
      [
        bundle,
        '--json',
        '--cwd',
        checkout,
        'launch',
        'sbx-plan-export',
        '--runtime',
        'pi',
        '--identity',
        'work',
        '--mode',
        'project',
        '--skill-policy',
        'clean',
        '--workspace',
        'clone',
        '--network-policy',
        'implementation',
      ],
      { cwd: checkout, env },
    );
    const envelope = JSON.parse(result.stdout),
      text = result.stdout;
    expect(parseSbxLaunchPlanExportV1(envelope.data)).toEqual(envelope.data);
    expect(envelope).toMatchObject({
      ok: true,
      data: { runtime: 'pi', identity: { name: 'work' }, sandbox: { profile: 'implementation' } },
    });
    expect(text).not.toContain(checkout);
    expect(text).not.toContain(env.APPDATA!);
    expect(text).not.toContain(env.LOCALAPPDATA!);
    expect({
      checkout: await readdir(checkout),
      state: await readdir(env.LOCALAPPDATA!),
      appdata: await readdir(env.APPDATA!),
    }).toEqual(before);
  });

  it('exports the selected open policy as allow-default with no remote profile or deny evidence', async () => {
    const cwd = await fixture(valid),
      env: NodeJS.ProcessEnv = {
        ...(await configuredLaunchEnv(cwd)),
        LOCALAPPDATA: await directory('mpx-open-plan-state-'),
        MPX_RELEASE_ROOT: await proofReleaseRoot(),
      },
      io = captureIo(),
      catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'sbx-plan-export',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'project',
          '--skill-policy',
          'clean',
          '--network-policy',
          'open',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    const plan = JSON.parse(io.out[0]!).data;
    expect(plan.sandbox).toMatchObject({ profile: 'open' });
    expect(plan.sandbox.createArgv).not.toContain('--profile');
    expect(plan.policyMatrix).toEqual([
      {
        profile: 'open',
        default: 'allow',
        targets: [{ target: 'example.com:443', decision: 'allow' }],
      },
    ]);
  });

  it('exports a strict deterministic launch-bound sbx plan without process, daemon, auth, projection, or local-state mutation', async () => {
    const cwd = await fixture(valid),
      env: NodeJS.ProcessEnv = {
        ...(await configuredLaunchEnv(cwd)),
        LOCALAPPDATA: await directory('mpx-plan-state-'),
        MPX_RELEASE_ROOT: await proofReleaseRoot(),
      },
      catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    const before = {
      cwd: await readdir(cwd),
      state: await readdir(env.LOCALAPPDATA!),
      appdata: await readdir(env['APPDATA']!),
    };
    const forbidden = vi.fn(async () => {
      throw new Error('read-only export crossed a mutation/process boundary');
    });
    const context = {
      env,
      catalogRoot,
      sbxDiagnostics: forbidden,
      accountAuthVerifier: { verify: forbidden },
      rootAttestationService: { verify: forbidden },
      launchRoutes: { materialize: forbidden },
      launchExecutorAdapters: [{ execute: forbidden }],
    } as never;
    const argv = [
      '--json',
      '--cwd',
      cwd,
      'launch',
      'sbx-plan-export',
      '--runtime',
      'pi',
      '--identity',
      'work',
      '--mode',
      'project',
      '--skill-policy',
      'clean',
      '--network-policy',
      'minimal',
    ];
    const first = captureIo(),
      second = captureIo();
    expect(await run(argv, first, context), JSON.stringify(first.out)).toBe(0);
    expect(await run(argv, second, context), JSON.stringify(second.out)).toBe(0);
    const one = JSON.parse(first.out[0]!).data,
      two = JSON.parse(second.out[0]!).data;
    expect(parseSbxLaunchPlanExportV1(one)).toEqual(one);
    expect(two).toEqual(one);
    expect(Object.keys(one)).toEqual([
      'schemaVersion',
      'exportKey',
      'launchKey',
      'descriptorSha256',
      'runtime',
      'identity',
      'artifact',
      'evidence',
      'sandbox',
      'policyMatrix',
    ]);
    expect(one).toMatchObject({
      schemaVersion: 1,
      runtime: 'pi',
      identity: { name: 'work', domain: 'work' },
      sandbox: {
        profile: 'minimal',
        proofSandboxName: expect.stringMatching(/^mpx-proof-[a-f0-9]{12}$/u),
      },
      policyMatrix: [{ profile: 'minimal' }],
    });
    expect(one.policyMatrix).toHaveLength(1);
    expect(forbidden).not.toHaveBeenCalled();
    expect({
      cwd: await readdir(cwd),
      state: await readdir(env.LOCALAPPDATA!),
      appdata: await readdir(env['APPDATA']!),
    }).toEqual(before);
  });

  it.each([
    ['missing runtime', ['--identity', 'work'], 'RUNTIME'],
    ['missing identity', ['--runtime', 'pi'], 'IDENTITY_REQUIRED'],
    ['invalid runtime', ['--runtime', 'ruby', '--identity', 'work'], 'RUNTIME_INVALID'],
    [
      'host executor',
      ['--runtime', 'pi', '--identity', 'work', '--executor', 'host'],
      'EXECUTOR_UNAVAILABLE',
    ],
  ])('rejects %s for sbx plan export', async (_label, options, code) => {
    const cwd = await fixture(valid),
      env = {
        ...(await configuredLaunchEnv(cwd)),
        LOCALAPPDATA: await directory('mpx-plan-reject-'),
        MPX_DEV_MODE: '1',
      },
      io = captureIo();
    expect(
      await run(['--json', '--cwd', cwd, 'launch', 'sbx-plan-export', ...options], io, {
        env,
        catalogRoot: fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url)),
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: expect.stringContaining(code) },
    });
  });

  it('changes the sbx export key when bound plan, artifact, or policy inputs change', async () => {
    const cwd = await fixture(valid),
      env: NodeJS.ProcessEnv = {
        ...(await configuredLaunchEnv(cwd)),
        LOCALAPPDATA: await directory('mpx-plan-keys-'),
        MPX_RELEASE_ROOT: await proofReleaseRoot(),
      },
      catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    const exportPlan = async (extra: string[]) => {
      const io = captureIo();
      expect(
        await run(
          [
            '--json',
            '--cwd',
            cwd,
            'launch',
            'sbx-plan-export',
            '--runtime',
            'pi',
            '--identity',
            'work',
            '--mode',
            'project',
            '--skill-policy',
            'clean',
            ...extra,
          ],
          io,
          { env, catalogRoot },
        ),
        JSON.stringify(io.out),
      ).toBe(0);
      return JSON.parse(io.out[0]!).data;
    };
    const baseline = await exportPlan(['--network-policy', 'minimal']),
      planChanged = await exportPlan(['--network-policy', 'implementation']);
    const skillDirectory = path.join(cwd, '.agents', 'skills', 'export-key');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: export-key\ndescription: Export key fixture\nmetadata:\n  mpx:\n    projectExposure: full\n---\nBOUND ARTIFACT CHANGE\n',
    );
    const artifactChanged = await exportPlan(['--network-policy', 'minimal']);
    expect(
      new Set([baseline.exportKey, planChanged.exportKey, artifactChanged.exportKey]).size,
    ).toBe(3);
    expect(planChanged.sandbox.planKey).not.toBe(baseline.sandbox.planKey);
    expect(artifactChanged.artifact.artifactKey).not.toBe(baseline.artifact.artifactKey);
  });

  it('resolves and inspects a launch without executing a harness', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'project',
          '--skill-policy',
          'clean',
          '--executor',
          'docker',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    const text = io.out[0]!,
      body = JSON.parse(text);
    expect(io.err).toEqual([]);
    expect(io.out).toHaveLength(1);
    expect(body).toEqual({
      apiVersion: 1,
      ok: true,
      data: expect.objectContaining({
        schemaVersion: 2,
        launchKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtime: 'pi',
        identity: { name: 'work', domain: 'work' },
        binding: { projectId: 'sample/app', repositoryId: 'sample/app' },
        mode: 'project',
        skillPolicy: 'clean',
        executor: expect.objectContaining({
          name: 'docker',
          effectiveEnforcement: 'mount-enforced',
        }),
        executorVerification: expect.objectContaining({ status: 'unverified' }),
        intendedPolicy: expect.objectContaining({
          resources: { 'selected-project': 'read-write' },
        }),
        skillArtifact: expect.objectContaining({
          artifactKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          runtime: 'pi',
          identity: 'work',
          skillPolicy: 'clean',
          contentScope: 'work',
          projectId: 'sample/app',
          catalogHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          effectivePolicyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
      warnings: [],
    });
    expect(text).not.toContain('runtimeRoots');
    expect(text).not.toContain('C:/native');
  });

  it('discovers an ordinary launch project exactly once and binds that snapshot throughout preparation', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo(),
      catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    const config = JSON.parse(valid);
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ root: cwd, path: path.join(cwd, 'mpxconfig.json'), config })
      .mockResolvedValueOnce({
        root: cwd,
        path: path.join(cwd, 'mpxconfig.json'),
        config: { ...config, project: { id: 'changed/project' } },
      });

    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'project',
          '--skill-policy',
          'clean',
          '--executor',
          'docker',
        ],
        io,
        { env, catalogRoot, discoverProjectConfig: discover } as never,
      ),
    ).toBe(0);
    expect(discover).toHaveBeenCalledOnce();
    expect(JSON.parse(io.out[0]!).data.binding).toEqual({
      projectId: 'sample/app',
      repositoryId: 'sample/app',
    });
  });

  it('resolves launch inspection in a known ordinary non-project directory only when an explicit non-project mode is selected', async () => {
    const cwd = await directory(),
      env = await configuredLaunchEnv(cwd),
      catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));

    const explicitIo = captureIo();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'developer',
          '--skill-policy',
          'clean',
          '--executor',
          'docker',
        ],
        explicitIo,
        { env, catalogRoot },
      ),
    ).toBe(0);
    expect(JSON.parse(explicitIo.out[0]!).data).toMatchObject({
      mode: 'developer',
      skillArtifact: { projectId: null, identity: 'work', contentScope: 'work', runtime: 'pi' },
    });

    const inferredIo = captureIo();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--skill-policy',
          'clean',
          '--executor',
          'docker',
        ],
        inferredIo,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(inferredIo.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_REQUIRED' },
    });
  });

  it('keeps assistant inferred non-project launch resolution successful without grants or project id', async () => {
    const cwd = await directory('mpx-assistant-launch-');
    const env = await configuredLaunchEnv(cwd, {
      domains: { work: [await directory('mpx-work-root-')], 'assistant-input': [cwd] },
      contentScopes: {
        work: { roots: [await directory('mpx-other-work-root-')], skillPacks: ['core'] },
        'assistant-input': { roots: [cwd], skillPacks: ['core'] },
      },
    });
    const io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--skill-policy',
          'clean',
          '--executor',
          'docker',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toMatchObject({
      mode: 'personal-assistant',
      skillArtifact: { projectId: null, contentScope: 'assistant-input', runtime: 'pi' },
    });
  });

  it('keeps oss inferred non-project launch resolution successful without grants or project id', async () => {
    const cwd = await directory('mpx-oss-launch-');
    const env = await configuredLaunchEnv(cwd, {
      domains: { work: [await directory('mpx-work-root-')], oss: [cwd] },
      contentScopes: {
        work: { roots: [await directory('mpx-other-work-root-')], skillPacks: ['core'] },
        'cloned-repositories': { roots: [cwd], skillPacks: ['core'] },
      },
    });
    const io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--skill-policy',
          'clean',
          '--executor',
          'docker',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toMatchObject({
      mode: 'developer',
      skillArtifact: { projectId: null, contentScope: 'cloned-repositories', runtime: 'pi' },
    });
  });

  it('surfaces stable invalid-grant errors from launch inspection', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'project',
          '--skill-policy',
          'clean',
          '--grant',
          'write:C:/work',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'GRANT_INVALID' } });
  });

  it('returns the full stable approval-required envelope for untrusted raw grants', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'project',
          '--skill-policy',
          'clean',
          '--grant',
          'ro:work',
          '--reason',
          'Inspect project',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(io.err).toEqual([]);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toEqual({
      apiVersion: 1,
      ok: false,
      error: {
        code: 'GRANT_APPROVAL_REQUIRED',
        message:
          "Grant 'ro:work' requires a separate exact trusted approval with the launch reason.",
        retryable: false,
        remediation: 'Confirm the grant through the trusted launch flow and relaunch.',
      },
      warnings: [],
    });
  });

  it('surfaces a stable missing-elevation-reason error', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'unrestricted',
          '--skill-policy',
          'clean',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'ELEVATION_REASON_REQUIRED' },
    });
  });

  it('surfaces a stable unavailable-executor error', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'project',
          '--skill-policy',
          'clean',
          '--executor',
          'podman',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'EXECUTOR_UNAVAILABLE' },
    });
  });

  it('classifies a requested nested CWD rather than the discovered repository root', async () => {
    const root = await fixture(valid),
      nested = path.join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    const env = await configuredLaunchEnv(root, { classifiedRoot: nested }),
      io = captureIo();
    expect(await run(['--json', '--cwd', nested, 'config', 'resolve'], io, { env })).toBe(0);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      apiVersion: 1,
      ok: true,
      data: {
        cwdClassification: { status: 'known', domain: 'work' },
        contentScope: { name: 'work', root: expect.any(String) },
      },
      warnings: [],
    });
  });

  it('surfaces a stable unknown-CWD error', async () => {
    const cwd = await fixture(valid),
      other = await mkdtemp(path.join(tmpdir(), 'mpx-known-')),
      env = await configuredLaunchEnv(cwd, { classifiedRoot: other }),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'launch',
          'explain',
          '--runtime',
          'pi',
          '--identity',
          'work',
          '--mode',
          'project',
          '--skill-policy',
          'clean',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'CWD_CLASSIFICATION_UNKNOWN' },
    });
  });

  it.each([
    ['full descriptor', ['--runtime', 'pi', '--mode', 'project', '--skill-policy', 'clean']],
    ['optional-runtime identity explanation', []],
  ])('surfaces a stable identity-domain mismatch error for %s', async (_label, options) => {
    const cwd = await fixture(valid),
      personal = await mkdtemp(path.join(tmpdir(), 'mpx-personal-')),
      env = await configuredLaunchEnv(cwd, {
        identityDomain: 'personal',
        extraDomains: { personal: [personal] },
      }),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        ['--json', '--cwd', cwd, 'launch', 'explain', '--identity', 'work', ...options],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'IDENTITY_DOMAIN_MISMATCH' },
    });
  });

  it('surfaces the first stable skill-catalog diagnostic message from runtime skill search', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'skill',
          'search',
          'review',
          '--identity',
          'work',
          '--runtime',
          'pi',
          '--skill-policy',
          'clean',
          '--artifact-key',
          'stale',
        ],
        io,
        { env, catalogRoot },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: {
        code: 'STALE_ARTIFACT',
        message: 'runtime operation requires the current exact v4 artifact',
      },
    });
  });

  it('surfaces typed Docker admission setup errors instead of collapsing them into an unverified gate', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    env.LOCALAPPDATA = env.APPDATA;
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    const rootAttestationService = {
      verify: async (identity: { domain: string; name: string }) => ({
        schemaVersion: 1 as const,
        ref: 'test-work',
        identity,
        runtime: 'pi' as const,
        rootDigest: 'a'.repeat(64),
        mode: 'root-attested' as const,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
    };
    expect(
      await run(['--json', '--cwd', cwd, 'launch', 'pi', '--identity', 'work'], io, {
        env,
        catalogRoot,
        rootAttestationService: rootAttestationService as never,
        accountAuthVerifier: { verify: async () => undefined },
        launchRoutes: { materialize: async () => ({}) },
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'PLAN_EXPORT_REQUIRED', details: { executor: 'docker' } },
    });
  });

  it('launch surfaces injected sbx diagnostics before the unverified Docker gate', async () => {
    const cwd = await fixture(valid),
      env = await configuredLaunchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(['--json', '--cwd', cwd, 'launch', 'pi', '--identity', 'work'], io, {
        env,
        catalogRoot,
        launchRoutes: { materialize: async () => ({}) },
        sbxDiagnostics: async () => ({
          available: true,
          failureCodes: ['DAEMON_STOPPED'],
          readOnly: true,
        }),
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'DAEMON_STOPPED', details: { executor: 'docker' } },
    });
  });

  it('doctor reports a missing managed main reservation without allocating', async () => {
    const config = JSON.stringify({
      schemaVersion: 1,
      project: { id: 'sample/app' },
      repository: { provider: 'generic', remote: 'origin' },
      development: {
        services: {
          app: {
            scope: 'checkout',
            port: { mode: 'managed', preferred: 4173 },
            start: { type: 'package-script', script: 'dev' },
          },
        },
      },
    });
    const cwd = await fixture(config),
      env = await launchEnv(cwd),
      io = captureIo();
    let ensured = false;
    let doctorRequest: { config: unknown; configHash: string } | undefined;
    const portService = {
      resolve: async (request: { config: unknown; configHash: string }) => {
        doctorRequest = request;
        throw new MpxError({ code: 'PORT_LEASE_INVALID', message: 'missing' });
      },
      ensure: async () => {
        ensured = true;
      },
    } as never;
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(['--json', '--cwd', cwd, 'doctor'], io, { env, portService, catalogRoot }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!).data.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PORT_LEASE_INVALID', severity: 'error' }),
      ]),
    );
    expect(ensured).toBe(false);
    expect(doctorRequest!.configHash).toBe(sha256Canonical(doctorRequest!.config as JsonValue));
  });

  it('doctor includes read-only standalone sbx diagnostics without making Docker required', async () => {
    const cwd = await fixture(valid),
      env = await launchEnv(cwd),
      io = captureIo();
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(['--json', '--cwd', cwd, 'doctor'], io, {
        env,
        catalogRoot,
        sbxDiagnostics: async () => ({
          available: false,
          failureCodes: ['SBX_NOT_FOUND'],
          readOnly: true,
        }),
      }),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!).data.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SBX_NOT_FOUND', severity: 'warning' }),
      ]),
    );
  });

  it('doctor surfaces the default sbx diagnostic composition through a fake argv process transport', async () => {
    const cwd = await fixture(valid),
      env = await launchEnv(cwd),
      io = captureIo(),
      calls: string[][] = [];
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    const runner: BoundedProcessRunner = {
      run: async (request) => {
        calls.push([...request.argv]);
        const command = request.argv.join(' ');
        if (command === 'version') {
          return {
            exitCode: 0,
            stdout: 'sbx version: v0.40.0 def8cb0523a77e757bdd6ef52b459fe374f3783e\n',
            stderr: '',
            truncated: false,
          };
        }
        if (command === '--help') {
          return {
            exitCode: 0,
            stdout:
              'Available Commands:\n create x\n daemon x\n diagnose x\n exec x\n ls x\n policy x\n ports x\n rm x\n run x\n version x\n',
            stderr: '',
            truncated: false,
          };
        }
        if (command === 'daemon status --json') {
          return {
            exitCode: 0,
            stdout: '{"status":"stopped","socket":"pipe"}',
            stderr: '',
            truncated: false,
          };
        }
        return {
          exitCode: 0,
          stdout:
            '{"version":"1.0","checks":[{"name":"Authentication","status":"pass","message":"ok","detail":"","hint":""}],"summary":{"pass":1,"warn":0,"fail":0,"skip":0}}',
          stderr: '',
          truncated: false,
        };
      },
    };
    const sbxDiagnostics = () =>
      createDefaultSbxDiagnostics(env, cwd, {
        resolveExecutable: async () => 'C:/trusted/sbx.exe',
        runner,
      });

    expect(
      await run(['--json', '--cwd', cwd, 'doctor'], io, { env, catalogRoot, sbxDiagnostics }),
    ).toBe(0);

    expect(JSON.parse(io.out[0]!).data.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'VERSION_UNSUPPORTED', severity: 'warning' }),
        expect.objectContaining({ code: 'DAEMON_STOPPED', severity: 'warning' }),
      ]),
    );
    expect(calls.map((call) => call.join(' '))).toEqual([
      'version',
      '--help',
      'daemon status --json',
      'diagnose --output json',
      'policy ls --json',
    ]);
    expect(calls.flat()).not.toEqual(
      expect.arrayContaining(['start', 'reset', 'create', 'run', 'rm']),
    );
  });

  it('doctor warns deterministically for fixed-shared services without requiring a reservation', async () => {
    const config = JSON.stringify({
      schemaVersion: 1,
      project: { id: 'sample/app' },
      repository: { provider: 'generic', remote: 'origin' },
      development: {
        services: {
          app: {
            scope: 'checkout',
            port: { mode: 'fixed-shared', preferred: 4173 },
            start: { type: 'package-script', script: 'dev' },
          },
        },
      },
    });
    const cwd = await fixture(config),
      env = await launchEnv(cwd),
      io = captureIo();
    let resolved = false;
    const catalogRoot = fileURLToPath(new URL('../fixtures/skill-catalog', import.meta.url));
    expect(
      await run(['--json', '--cwd', cwd, 'doctor'], io, {
        env,
        portService: {
          resolve: async () => {
            resolved = true;
          },
        } as never,
        catalogRoot,
      }),
    ).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!).data.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FIXED_SHARED_LIMITATION', severity: 'warning' }),
      ]),
    );
    expect(resolved).toBe(false);
  });

  it('reports unavailable default state roots without touching user state', async () => {
    const io = captureIo();
    expect(await run(['--json', 'ports', 'list'], io, { env: {} })).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'STATE_ROOT_UNAVAILABLE' },
    });
  });

  it('sorts injected global leases and emits one envelope', async () => {
    const io = captureIo();
    const leases = [{ leaseId: 'z' }, { leaseId: 'a' }] as never[];
    const portService = { list: async () => leases } as never;
    expect(await run(['--json', 'ports', 'list'], io, { env: {}, portService })).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!).data.map((lease: { leaseId: string }) => lease.leaseId)).toEqual([
      'a',
      'z',
    ]);
  });

  it('delegates every read/write ports command with one envelope', async () => {
    const cwd = await fixture(valid),
      calls: string[] = [],
      requests: unknown[] = [];
    const lease = {
      leaseId: 'lease',
      projectId: 'sample/app',
      worktreeId: 'worktree',
      configHash: 'hash',
      services: { app: 4173 },
    };
    const portService = {
      ensure: async (request: unknown) => {
        calls.push('ensure');
        requests.push(request);
        return {
          lease,
          warnings: [{ code: 'FIXED_SHARED_DUPLICATE', message: 'shared', port: 4173 }],
        };
      },
      resolve: async (request: unknown) => {
        calls.push('resolve');
        requests.push(request);
        return lease;
      },
      inspect: async () => {
        calls.push('inspect');
        return [];
      },
      release: async () => {
        calls.push('release');
      },
      reconcile: async () => {
        calls.push('reconcile');
        return { removed: [], repaired: [] };
      },
    } as never;
    for (const action of ['ensure', 'resolve', 'inspect', 'release', 'reconcile']) {
      const io = captureIo();
      expect(
        await run(['--json', '--cwd', cwd, 'ports', action], io, { env: {}, portService }),
      ).toBe(0);
      expect(io.out).toHaveLength(1);
      expect(JSON.parse(io.out[0]!)).toMatchObject({ apiVersion: 1, ok: true });
    }
    expect(calls).toEqual(['ensure', 'resolve', 'inspect', 'release', 'reconcile']);
    const discovered = JSON.parse(valid);
    for (const value of requests) {
      const request = value as { config: unknown; configHash: string };
      expect(request.config).toEqual(discovered);
      expect(request.configHash).toBe(sha256Canonical(discovered as JsonValue));
    }
    const changed = { ...discovered, repository: { ...discovered.repository, remote: 'changed' } };
    expect(sha256Canonical(changed as JsonValue)).not.toBe(
      sha256Canonical(discovered as JsonValue),
    );
  });

  it('delegates strict ports rebuild with known roots in one envelope', async () => {
    const cwd = await fixture(valid),
      known = await mkdtemp(path.join(tmpdir(), 'mpx-known-'));
    const env = await configuredLaunchEnv(cwd, { extraDomains: { personal: [known] } });
    let request: { roots: string[] } | undefined;
    const portService = {
      rebuild: async (value: { roots: string[] }) => {
        request = value;
        return { discovered: 1, rebuilt: 1, roots: 2 };
      },
    } as never;
    const io = captureIo();
    expect(
      await run(['--json', '--cwd', cwd, 'ports', 'reconcile', '--rebuild'], io, {
        env,
        portService,
      }),
    ).toBe(0);
    expect(request!.roots).toEqual([path.resolve(cwd), path.resolve(known)]);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: true,
      data: { discovered: 1, rebuilt: 1, roots: 2 },
    });
  });

  it('rejects --rebuild on other ports commands as usage', async () => {
    const io = captureIo();
    expect(
      await run(['--json', 'ports', 'list', '--rebuild'], io, {
        env: {},
        portService: { list: async () => [] } as never,
      }),
    ).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
  });

  it('passes the full canonical config hash to status and changes it when config changes', async () => {
    const cwd = await fixture(valid),
      requests: Array<{ config: unknown; configHash: string }> = [];
    const statusProvider = {
      snapshot: async (request: { config: unknown; configHash: string }) => {
        requests.push(request);
        return {
          schemaVersion: 1,
          project: { id: 'sample', cwd },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'missing',
          services: [],
          diagnostics: [],
        };
      },
    } as never;
    expect(
      await run(['--json', '--cwd', cwd, 'status'], captureIo(), { env: {}, statusProvider }),
    ).toBe(0);
    const changed = {
      ...JSON.parse(valid),
      repository: { provider: 'generic', remote: 'changed' },
    };
    await writeFile(path.join(cwd, 'mpxconfig.json'), JSON.stringify(changed));
    expect(
      await run(['--json', '--cwd', cwd, 'status'], captureIo(), { env: {}, statusProvider }),
    ).toBe(0);
    expect(requests[0]!.configHash).toBe(sha256Canonical(requests[0]!.config as JsonValue));
    expect(requests[1]!.configHash).toBe(sha256Canonical(requests[1]!.config as JsonValue));
    expect(requests[1]!.configHash).not.toBe(requests[0]!.configHash);
  });

  it('places fixed-shared diagnostics in envelope warnings', async () => {
    const cwd = await fixture(valid),
      io = captureIo();
    const portService = {
      ensure: async () => ({
        lease: { leaseId: 'lease' },
        warnings: [{ code: 'FIXED_SHARED_DUPLICATE', message: 'shared', port: 4173 }],
      }),
    } as never;
    expect(
      await run(['--json', '--cwd', cwd, 'ports', 'ensure'], io, { env: {}, portService }),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!).warnings).toEqual([
      expect.objectContaining({ code: 'FIXED_SHARED_DUPLICATE', severity: 'warning' }),
    ]);
  });

  it.each(['list', 'inspect'])('rejects extra arguments for ports %s', async (action) => {
    const io = captureIo(),
      portService = { list: async () => [], inspect: async () => [] } as never;
    expect(await run(['--json', 'ports', action, 'extra'], io, { env: {}, portService })).toBe(2);
  });

  it('delegates the complete worktree CLI surface through injected dependencies', async () => {
    const cwd = await fixture(valid),
      calls: Array<[string, unknown]> = [];
    const worktreeService = {
      create: async (request: unknown) => {
        calls.push(['create', request]);
        return {
          schemaVersion: 1,
          owner: 'mpx',
          operation: 'create',
          status: 'ready',
          worktreePath: 'C:/repo.worktrees/feature/x',
        };
      },
      remove: async (request: unknown) => {
        calls.push(['remove', request]);
        return { schemaVersion: 1, owner: 'mpx', operation: 'remove', status: 'removed' };
      },
      list: async (request: unknown) => {
        calls.push(['list', request]);
        return [{ path: 'C:/repo', branch: 'main' }];
      },
      status: async (request: unknown) => {
        calls.push(['status', request]);
        return { schemaVersion: 1, owner: 'mpx', operation: 'status', status: 'ok' };
      },
      prepare: async (request: unknown) => {
        calls.push(['prepare', request]);
        return { schemaVersion: 1, status: 'ready' };
      },
      cancel: async (request: unknown) => {
        calls.push(['cancel', request]);
        return { schemaVersion: 1, status: 'cancelled' };
      },
      reconcile: async (request: unknown) => {
        calls.push(['reconcile', request]);
        return {
          schemaVersion: 1,
          owner: 'mpx',
          operation: 'reconcile',
          status: 'reconciled',
          orphaned: [],
        };
      },
      select: async (request: unknown) => {
        calls.push(['select', request]);
        return { path: 'C:/repo.worktrees/feature/x', branch: 'feature/x' };
      },
    } as never;
    const commands = [
      [
        'create',
        'feature/x',
        '--base',
        'origin/main',
        '--template',
        '{slug}',
        '--slug',
        'feature x',
        '--execution',
        'foreground',
      ],
      ['remove', 'C:/repo.worktrees/feature/x'],
      ['list'],
      ['status'],
      [
        'prepare',
        'feature/x',
        '--package-approval',
        'APPROVE PACKAGE',
        '--explicit-executable-approval',
        'APPROVE EXPLICIT',
      ],
      ['cancel', 'feature/x'],
      ['reconcile', '--orphan-approval', 'RESOLVE ORPHAN abc'],
    ];
    for (const command of commands) {
      const io = captureIo();
      expect(
        await run(['--json', '--cwd', cwd, 'worktree', ...command], io, {
          env: {},
          worktreeService,
        }),
      ).toBe(0);
      expect(io.out).toHaveLength(1);
      expect(JSON.parse(io.out[0]!)).toMatchObject({ apiVersion: 1, ok: true });
    }
    expect(calls.map(([name]) => name)).toEqual([
      'create',
      'remove',
      'list',
      'status',
      'prepare',
      'cancel',
      'reconcile',
    ]);
    expect(calls[0]![1]).toEqual({
      cwd,
      branch: 'feature/x',
      base: 'origin/main',
      execution: 'foreground',
    });
    expect(calls[4]![1]).toMatchObject({
      approval: JSON.stringify({
        packageAutomationApproval: 'APPROVE PACKAGE',
        explicitExecutableApproval: 'APPROVE EXPLICIT',
      }),
    });
  });

  it('ships source-only Bash and PowerShell cd wrappers without invoking them on load', async () => {
    const root = fileURLToPath(new URL('../../../..', import.meta.url));
    const bash = await readFile(path.join(root, 'scripts', 'mpx-worktree.bash'), 'utf8');
    const powershell = await readFile(path.join(root, 'scripts', 'mpx-worktree.ps1'), 'utf8');
    expect(bash).toContain('mpx worktree select --machine');
    expect(bash).toContain('cd --');
    expect(powershell).toContain('mpx worktree select --machine');
    expect(powershell).toContain('Set-Location -LiteralPath');

    const wrapperRoot = await mkdtemp(path.join(tmpdir(), 'mpx wrapper-'));
    const bashPath = path.join(wrapperRoot, 'mpx-worktree.bash'),
      powershellPath = path.join(wrapperRoot, 'mpx-worktree.ps1');
    await writeFile(bashPath, bash);
    await writeFile(powershellPath, powershell);
    await execFile('bash', ['-n', bashPath]);
    await execFile('bash', [
      '-c',
      'set -e; before=$PWD; . "$1"; test "$PWD" = "$before"',
      'mpx-wrapper-load',
      bashPath,
    ]);

    if (process.platform === 'win32') {
      const parserLoader = path.join(wrapperRoot, 'load-wrapper.ps1');
      await writeFile(
        parserLoader,
        `param([Parameter(Mandatory)][string]$WrapperPath)
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($WrapperPath, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
$before = (Get-Location).Path
. $WrapperPath
if ((Get-Location).Path -ne $before) { throw "location changed" }
`,
      );
      await execFile('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        parserLoader,
        powershellPath,
      ]);
    }
  });

  it('prints exactly one selected path in machine mode and no path on cancellation', async () => {
    const selected = captureIo();
    expect(
      await run(['worktree', 'select', '--machine', '--path', 'C:/repo worktrees/x'], selected, {
        env: {},
        worktreeService: { select: async () => ({ path: 'C:/repo worktrees/x' }) } as never,
      }),
    ).toBe(0);
    expect(selected.out).toEqual(['C:/repo worktrees/x\n']);
    expect(selected.err).toEqual([]);
    const cancelled = captureIo();
    expect(
      await run(['worktree', 'select', '--machine', '--cancel'], cancelled, {
        env: {},
        worktreeService: {
          select: async () => {
            throw new Error('must not run');
          },
        } as never,
      }),
    ).toBe(0);
    expect(cancelled.out).toEqual([]);
    expect(cancelled.err).toEqual([]);
  });

  it.each(['yes', 'force', 'delete-branch', 'trust'])(
    'rejects unsafe worktree bypass --%s',
    async (option) => {
      const io = captureIo();
      expect(
        await run(['--json', 'worktree', 'remove', 'x', `--${option}`], io, {
          env: {},
          worktreeService: {} as never,
        }),
      ).toBe(2);
      expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
    },
  );

  it('routes a validated positional PID through PortService.kill', async () => {
    const io = captureIo();
    let killed: number | undefined;
    const portService = {
      kill: async (pid: number) => {
        killed = pid;
      },
    } as never;
    expect(await run(['--json', 'ports', 'kill', '42'], io, { env: {}, portService })).toBe(0);
    expect(killed).toBe(42);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: true,
      data: { killed: true, pid: 42 },
      warnings: [],
    });
  });

  it('rejects ambiguous PID syntax', async () => {
    const io = captureIo();
    const portService = { kill: async () => undefined } as never;
    expect(
      await run(['--json', 'ports', 'kill', '42', '--pid', '42'], io, { env: {}, portService }),
    ).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
  });
});

it('exposes external verification only through mpx install verify', async () => {
  const root = await directory('mpx-cli-external-verify-'),
    file = path.join(root, 'intent-result.json'),
    releaseKey = 'a'.repeat(64);
  const built = {
    schemaVersion: 1,
    kind: 'install-intent-build-result',
    intent: {
      schemaVersion: 1,
      kind: 'install-intent',
      releaseKey,
      convergenceHash: releaseKey,
      components: ['cli'],
    },
    externalPlans: [],
  };
  await writeFile(file, JSON.stringify(built));
  const external = { schemaVersion: 1, kind: 'install-external-verification', integrations: [] },
    builderVerify = vi.fn(async () => external);
  const verification = {
    schemaVersion: 1,
    kind: 'install-verification',
    releaseKey: '',
    healthy: false,
    issues: ['receipt-missing'],
    checkedAt: '2025-01-01T00:00:00.000Z',
  };
  const verify = vi.fn(async (_strict: boolean, source?: () => Promise<unknown>) => {
    if (source) {
      await source();
    }
    return verification;
  });
  const context = {
    env: {},
    installOrchestrator: { verify },
    installIntentBuilder: { verify: builderVerify },
  } as never;
  expect(await run(['--json', 'install', 'verify'], captureIo(), context)).toBe(0);
  expect(builderVerify).not.toHaveBeenCalled();
  expect(
    await run(['--json', 'install', 'verify', '--external-plan', file], captureIo(), context),
  ).toBe(0);
  expect(builderVerify).toHaveBeenCalledExactlyOnceWith(built);
});
