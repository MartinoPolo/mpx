import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import {
  WorktreeLifecycleService,
  deriveLifecycleKey,
  type LifecycleDependencies,
  type LifecycleState,
  type LifecycleReleaseIdentity,
} from '../../src/lifecycle.js';
import type { WorktreeInventoryEntry } from '../../src/index.js';

const config: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'acme/widgets' },
  repository: { provider: 'generic', remote: 'origin' },
  tooling: { packageManager: 'pnpm' },
};
const main = 'C:\\MP Projects\\widget repo';
const target = 'C:\\MP Projects\\widget repo.worktrees\\feature\\issue-42';

function releaseIdentity(
  overrides: Partial<LifecycleReleaseIdentity> = {},
): LifecycleReleaseIdentity {
  return {
    schemaVersion: 1,
    leaseId: 'lease-1',
    projectId: 'acme/widgets',
    repositoryId: 'repository',
    worktreeId: 'linked-worktree',
    worktreePath: target,
    role: 'linked',
    configHash: 'hash',
    ...overrides,
  };
}

const linked: WorktreeInventoryEntry = {
  path: target,
  branch: 'feature/issue-42',
  head: 'abc',
  detached: false,
  locked: false,
  prunable: false,
};

function fixture(overrides: Partial<LifecycleDependencies> = {}) {
  const events: string[] = [];
  const states = new Map<string, LifecycleState>();
  let inventory: WorktreeInventoryEntry[] = [
    { path: main, branch: 'main', head: 'base', detached: false, locked: false, prunable: false },
  ];
  const repositoryIdentity = `${main}/.git`;
  const dependencies: LifecycleDependencies = {
    repository: {
      resolve: async () => ({
        mainRoot: main,
        commonGitDirectory: repositoryIdentity,
        configPath: `${main}/mpxconfig.json`,
        config,
      }),
    },
    git: {
      run: async (args) => {
        events.push(`git:${args.join('|')}`);
        if (args[0] === 'worktree' && args[1] === 'add') {
          inventory.push(linked);
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
          inventory = inventory.filter((item) => item.path !== target);
        }
        return Buffer.alloc(0);
      },
      list: async () => inventory,
      isDirty: async () => false,
      isInUse: async () => false,
    },
    lock: {
      acquire: async () => {
        events.push('lock');
        return async () => {
          events.push('unlock');
        };
      },
    },
    state: {
      load: async (key) => states.get(key),
      writeAtomic: async (key, value) => {
        events.push(`state:${value.status}`);
        states.set(key, structuredClone(value));
      },
    },
    ports: {
      ensure: async () => {
        events.push('ports:ensure');
        return { lease: { leaseId: 'lease-1' } };
      },
      captureReleaseIdentity: async () => {
        events.push('ports:capture');
        return {
          schemaVersion: 1,
          leaseId: 'lease-1',
          projectId: 'acme/widgets',
          repositoryId: 'repository',
          worktreeId: 'linked-worktree',
          worktreePath: target,
          role: 'linked',
          configHash: 'hash',
        };
      },
      releaseLinkedAfterRemoval: async () => {
        events.push('ports:release');
        return { released: true };
      },
      reconcile: async () => ({ orphaned: [] }),
    },
    preparation: {
      prepare: async (request) => {
        events.push(request.validateOnly ? 'validate' : 'prepare');
        return { status: request.validateOnly ? 'approved' : 'ready', key: request.key };
      },
      cancel: async () => {
        events.push('cancel');
        return { status: 'cancelled' };
      },
      reconcile: async () => ({ status: 'ready' }),
    },
    configHash: () => 'hash',
    ...overrides,
  };
  return {
    service: new WorktreeLifecycleService(dependencies),
    dependencies,
    events,
    states,
    inventory: () => inventory,
    repositoryIdentity,
  };
}

describe('worktree lifecycle create', () => {
  it('rejects a directory project before Git or mutation side effects', async () => {
    const value = fixture({
      repository: {
        resolve: async () => ({
          mainRoot: main,
          commonGitDirectory: `${main}/.git`,
          configPath: `${main}/mpxconfig.json`,
          config: {
            schemaVersion: 1,
            project: { id: 'local/widgets', kind: 'directory' },
          },
        }),
      },
      git: {
        run: async () => {
          value.events.push('git:run');
          return Buffer.alloc(0);
        },
        list: async () => {
          value.events.push('git:list');
          return [];
        },
        isDirty: async () => {
          value.events.push('git:dirty');
          return false;
        },
        isInUse: async () => {
          value.events.push('git:in-use');
          return false;
        },
      },
    });

    await expect(
      value.service.create({ cwd: main, branch: 'feature/directory-refused' }),
    ).rejects.toMatchObject({ code: 'PROJECT_REPOSITORY_REQUIRED' });
    expect(value.events).toEqual([]);
    expect(value.states.size).toBe(0);
  });

  it('requires production preparation approval before include and port effects, then resumes in order', async () => {
    const configured = {
      ...config,
      worktrees: {
        postCreate: {
          execution: 'foreground' as const,
          steps: [{ id: 'verify', uses: 'executable' as const, argv: ['node', '--version'] }],
        },
      },
    };
    const value = fixture({
      repository: {
        resolve: async () => ({
          mainRoot: main,
          commonGitDirectory: `${main}/.git`,
          configPath: `${main}/mpxconfig.json`,
          config: configured,
        }),
      },
      includes: {
        copy: async () => {
          value.events.push('includes:copy');
        },
      },
      ports: {
        ensure: async () => {
          value.events.push('ports:ensure');
          return { lease: { leaseId: 'lease-1' } };
        },
        captureReleaseIdentity: async () => releaseIdentity(),
        releaseLinkedAfterRemoval: async () => ({}),
        reconcile: async () => ({ orphaned: [] }),
      },
      preparation: {
        prepare: async (request) => {
          value.events.push(request.validateOnly ? 'preparation:validate' : 'preparation:run');
          if (request.validateOnly && request.exactApproval === undefined) {
            return {
              status: 'approval-required',
              expectedApproval: 'expected',
              approval: {
                schemaVersion: 1,
                owner: 'mpx',
                steps: [{ id: 'verify', kind: 'explicit-argv', digest: 'digest' }],
              },
            };
          }
          return { status: request.validateOnly ? 'approved' : 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'ready' }),
      },
    });
    const first = await value.service.create({
      cwd: main,
      branch: 'feature/issue-42',
      base: 'main',
    });
    expect(first).toMatchObject({
      status: 'approval-required',
      expectedApproval: 'expected',
      approval: { steps: [{ id: 'verify' }] },
      state: { status: 'approval-required', preparationStatus: 'approval-required' },
    });
    expect(value.events).not.toContain('includes:copy');
    expect(value.events).not.toContain('ports:ensure');

    value.events.length = 0;
    await expect(
      value.service.create({
        cwd: main,
        branch: 'feature/issue-42',
        base: 'main',
        approval: 'expected',
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(value.events).toEqual([
      'lock',
      'preparation:validate',
      'state:including',
      'includes:copy',
      'state:included',
      'state:allocating',
      'ports:ensure',
      'state:leased',
      'state:preparation-pending',
      'preparation:run',
      'state:ready',
      'unlock',
    ]);
  });

  it('persists copy-start evidence and only enables exact-destination recovery on retry', async () => {
    const recoveryFlags: boolean[] = [];
    let interrupted = true;
    const value = fixture({
      includes: {
        inspect: async () => ({
          status: 'approved',
          manifestSha256: 'manifest',
          expectedApproval: 'include-approval',
        }),
        copy: async (request) => {
          recoveryFlags.push(request.allowExistingRecovery === true);
          if (interrupted) {
            interrupted = false;
            throw new Error('copy interrupted');
          }
          return { manifestSha256: 'manifest' };
        },
      },
    });
    await expect(
      value.service.create({
        cwd: main,
        branch: 'feature/issue-42',
        base: 'main',
        includeApproval: 'include-approval',
      }),
    ).rejects.toMatchObject({ code: 'WORKTREE_CREATE_INCOMPLETE' });
    const key = deriveLifecycleKey(value.repositoryIdentity, 'feature/issue-42');
    expect(value.states.get(key)).toMatchObject({
      includeEvidence: {
        manifestSha256: 'manifest',
        expectedApproval: 'include-approval',
        copyStarted: true,
      },
    });
    await expect(
      value.service.create({
        cwd: main,
        branch: 'feature/issue-42',
        base: 'main',
        includeApproval: 'include-approval',
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(recoveryFlags).toEqual([false, true]);
  });

  it('recaptures fresh approval when durable preparation approval is stale and can continue', async () => {
    const configured = {
      ...config,
      worktrees: {
        postCreate: {
          execution: 'foreground' as const,
          steps: [{ id: 'verify', uses: 'executable' as const, argv: ['node', '--version'] }],
        },
      },
    };
    const value = fixture({
      repository: {
        resolve: async () => ({
          mainRoot: main,
          commonGitDirectory: `${main}/.git`,
          configPath: `${main}/mpxconfig.json`,
          config: configured,
        }),
      },
      preparation: {
        prepare: async (request) => {
          if (!request.validateOnly) {
            return { status: 'ready' };
          }
          if (request.exactApproval === 'old') {
            throw new MpxError({ code: 'PREPARATION_APPROVAL_STALE', message: 'changed evidence' });
          }
          if (request.exactApproval === 'fresh') {
            return {
              status: 'approved',
              expectedApproval: 'fresh',
              approval: {
                schemaVersion: 1,
                owner: 'mpx',
                steps: [{ id: 'verify', kind: 'explicit-argv', digest: 'fresh-digest' }],
              },
            };
          }
          return {
            status: 'approval-required',
            expectedApproval: 'fresh',
            approval: {
              schemaVersion: 1,
              owner: 'mpx',
              steps: [{ id: 'verify', kind: 'explicit-argv', digest: 'fresh-digest' }],
            },
          };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'ready' }),
      },
    });

    const initial = await value.service.create({
      cwd: main,
      branch: 'feature/issue-42',
      base: 'main',
    });
    expect(initial).toMatchObject({ status: 'approval-required', expectedApproval: 'fresh' });
    const stale = await value.service.create({
      cwd: main,
      branch: 'feature/issue-42',
      base: 'main',
      approval: 'old',
    });
    expect(stale).toMatchObject({
      status: 'approval-required',
      expectedApproval: 'fresh',
      approval: { steps: [{ digest: 'fresh-digest' }] },
      state: { status: 'approval-required', preparationStatus: 'approval-required' },
    });
    expect(
      value.states.get(deriveLifecycleKey(value.repositoryIdentity, 'feature/issue-42')),
    ).not.toMatchObject({ status: 'unknown' });
    await expect(
      value.service.create({
        cwd: main,
        branch: 'feature/issue-42',
        base: 'main',
        approval: 'fresh',
      }),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('keeps pre-run validation failures retryable without reconciling missing preparation state', async () => {
    const configured = {
      ...config,
      worktrees: {
        postCreate: {
          execution: 'foreground' as const,
          steps: [{ id: 'verify', uses: 'executable' as const, argv: ['node', '--version'] }],
        },
      },
    };
    let validations = 0;
    let runs = 0;
    const value = fixture({
      repository: {
        resolve: async () => ({
          mainRoot: main,
          commonGitDirectory: `${main}/.git`,
          configPath: `${main}/mpxconfig.json`,
          config: configured,
        }),
      },
      preparation: {
        prepare: async (request) => {
          if (request.validateOnly && validations++ === 0) {
            throw new MpxError({ code: 'PREPARATION_STATE_MISSING', message: 'missing' });
          }
          if (request.validateOnly) {
            return { status: 'approved' };
          }
          runs += 1;
          return { status: 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => {
          throw new Error('must not reconcile validation');
        },
      },
    });
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_CREATE_INCOMPLETE' });
    expect([...value.states.values()][0]).toMatchObject({
      status: 'failed',
      failure: { code: 'PREPARATION_STATE_MISSING' },
    });
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(runs).toBe(1);
  });

  it('creates with direct Git argv, persists state, then allocates ports and prepares while holding the repository lock', async () => {
    const value = fixture();
    const result = await value.service.create({
      cwd: main,
      branch: 'feature/issue-42',
      base: 'origin/main',
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      owner: 'mpx',
      operation: 'create',
      status: 'ready',
      worktreePath: target,
      leaseId: 'lease-1',
    });
    expect(value.events).toEqual([
      'lock',
      'state:creating',
      `git:worktree|add|-b|feature/issue-42|--|${target}|origin/main`,
      'state:created',
      'state:including',
      'state:included',
      'state:allocating',
      'ports:ensure',
      'state:leased',
      'state:preparation-pending',
      'prepare',
      'state:ready',
      'unlock',
    ]);
  });

  it('durably resumes the exact include, port, and preparation stages after phase-boundary crashes', async () => {
    const configured = {
      ...config,
      worktrees: {
        postCreate: {
          execution: 'foreground' as const,
          steps: [{ id: 'verify', uses: 'executable' as const, argv: ['node', '--version'] }],
        },
      },
    };
    const effects: string[] = [];
    const value = fixture({
      repository: {
        resolve: async () => ({
          mainRoot: main,
          commonGitDirectory: `${main}/.git`,
          configPath: `${main}/mpxconfig.json`,
          config: configured,
        }),
      },
      includes: {
        inspect: async (request) => ({
          status:
            request.exactHumanApproval === 'include-approval' ? 'approved' : 'approval-required',
          manifestSha256: 'manifest',
          expectedApproval: 'include-approval',
        }),
        copy: async () => {
          effects.push('includes');
          return { manifestSha256: 'manifest' };
        },
      },
      ports: {
        ensure: async () => {
          effects.push('ports');
          return { lease: { leaseId: 'lease-1' } };
        },
        captureReleaseIdentity: async () => releaseIdentity(),
        releaseLinkedAfterRemoval: async () => ({}),
        reconcile: async () => ({ orphaned: [] }),
      },
      preparation: {
        prepare: async (request) => {
          if (request.validateOnly) {
            return request.exactApproval === 'prep-approval'
              ? {
                  status: 'approved',
                  expectedApproval: 'prep-approval',
                  approval: {
                    schemaVersion: 1,
                    owner: 'mpx',
                    steps: [{ id: 'verify', kind: 'explicit-argv', digest: 'step-digest' }],
                  },
                }
              : {
                  status: 'approval-required',
                  expectedApproval: 'prep-approval',
                  approval: {
                    schemaVersion: 1,
                    owner: 'mpx',
                    steps: [{ id: 'verify', kind: 'explicit-argv', digest: 'step-digest' }],
                  },
                };
          }
          effects.push('preparation');
          return { status: 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => {
          throw new MpxError({ code: 'PREPARATION_STATE_MISSING', message: 'missing' });
        },
      },
    });
    const originalWrite = value.dependencies.state.writeAtomic;
    const failed = new Set(['included', 'leased', 'preparation-pending']);
    value.dependencies.state.writeAtomic = async (key, state) => {
      if (failed.delete(state.status)) {
        throw new Error(`crash:${state.status}`);
      }
      await originalWrite(key, state);
    };

    await expect(
      value.service.create({
        cwd: main,
        branch: 'feature/issue-42',
        base: 'main',
        includeApproval: 'include-approval',
        approval: 'prep-approval',
      }),
    ).rejects.toThrow('crash:included');
    expect(effects).toEqual(['includes']);
    value.dependencies.state.list = async () => [...value.states.values()];
    const fresh = () => new WorktreeLifecycleService(value.dependencies);
    await expect(fresh().reconcile({ cwd: main })).rejects.toThrow('crash:leased');
    expect(effects).toEqual(['includes', 'ports']);
    await expect(fresh().reconcile({ cwd: main })).rejects.toThrow('crash:preparation-pending');
    expect(effects).toEqual(['includes', 'ports', 'ports']);
    await expect(fresh().reconcile({ cwd: main })).resolves.toMatchObject({ status: 'reconciled' });
    expect(effects).toEqual(['includes', 'ports', 'ports', 'preparation']);
    const state = [...value.states.values()][0];
    expect(state).toMatchObject({
      status: 'ready',
      includeEvidence: { manifestSha256: 'manifest' },
      preparationEvidence: {
        expectedApproval: 'prep-approval',
        approval: {
          schemaVersion: 1,
          owner: 'mpx',
          steps: [{ id: 'verify', kind: 'explicit-argv', digest: 'step-digest' }],
        },
      },
    });
    expect(JSON.stringify(state)).not.toContain('secret-value');
  });

  it('persists the exact creation config hash and rejects resume under different durable config evidence', async () => {
    const value = fixture({
      configHash: (current) => (current === config ? 'creation-hash' : 'changed-hash'),
    });
    let writes = 0;
    value.dependencies.state.writeAtomic = async (key, state) => {
      writes += 1;
      if (writes === 2) {
        throw new Error('created write failed');
      }
      value.states.set(key, structuredClone(state));
    };
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toThrow('created write failed');
    expect([...value.states.values()][0]).toMatchObject({
      status: 'creating',
      configHash: 'creation-hash',
    });

    const changed = {
      ...config,
      project: { id: 'acme/widgets' },
      tooling: { packageManager: 'auto' as const },
    };
    value.dependencies.repository.resolve = async () => ({
      mainRoot: main,
      commonGitDirectory: value.repositoryIdentity,
      configPath: `${main}/mpxconfig.json`,
      config: changed,
    });
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_CONFIG_HASH_MISMATCH' });
    expect(value.events.filter((event) => event.startsWith('git:worktree|add'))).toHaveLength(1);
  });

  it('persists creating intent before Git and resumes from inventory when the post-Git state write failed', async () => {
    const value = fixture();
    let writes = 0;
    value.dependencies.state.writeAtomic = async (key, state) => {
      value.events.push(`state:${state.status}`);
      writes += 1;
      if (writes === 2) {
        throw new Error('disk full');
      }
      value.states.set(key, structuredClone(state));
    };

    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toThrow('disk full');
    expect(value.inventory()).toContainEqual(linked);
    expect([...value.states.values()][0]).toMatchObject({
      status: 'creating',
      worktreePath: target,
    });
    expect(value.events.slice(0, 4)).toEqual([
      'lock',
      'state:creating',
      `git:worktree|add|-b|feature/issue-42|--|${target}|main`,
      'state:created',
    ]);

    value.events.length = 0;
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(value.events).not.toContain(`git:worktree|add|-b|feature/issue-42|${target}|main`);
  });

  it('recreates an intentionally removed branch and reconcile preserves its removal history', async () => {
    const value = fixture();
    const first = await value.service.create({
      cwd: main,
      branch: 'feature/issue-42',
      base: 'main',
    });
    await value.service.remove({ cwd: main, worktreePath: first.worktreePath! });
    const removed = [...value.states.values()][0];
    if (!removed) {
      throw new Error('removed lifecycle state was not persisted');
    }
    value.dependencies.state.list = async () => [removed];

    await value.service.reconcile({ cwd: main });
    expect(removed).toMatchObject({ status: 'removed' });
    expect(removed.externalDeletion).toBeUndefined();

    const recreated = await value.service.create({
      cwd: main,
      branch: 'feature/issue-42',
      base: 'main',
    });
    expect(recreated).toMatchObject({ status: 'ready', worktreePath: target });
    expect(value.events.filter((event) => event.startsWith('git:worktree|add'))).toHaveLength(2);
  });

  it('uses the explicitly requested preparation execution mode', async () => {
    let execution: unknown;
    const value = fixture({
      preparation: {
        prepare: async (request) => {
          execution = request.plan.execution;
          return { status: 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'ready' }),
      },
    });
    await value.service.create({
      cwd: main,
      branch: 'feature/issue-42',
      base: 'main',
      execution: 'background',
    });
    expect(execution).toBe('background');
  });

  it('passes the configured package-manager selection without coercing auto', async () => {
    let packageManager: unknown;
    const value = fixture({
      preparation: {
        prepare: async (request) => {
          packageManager = request.packageManager;
          return { status: 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'ready' }),
      },
    });
    await value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    expect(packageManager).toBe('pnpm');

    const autoConfig = { ...config, tooling: { packageManager: 'auto' as const } };
    const auto = fixture({
      repository: {
        resolve: async () => ({
          mainRoot: main,
          commonGitDirectory: `${main}/.git`,
          configPath: `${main}/mpxconfig.json`,
          config: autoConfig,
        }),
      },
      preparation: {
        prepare: async (request) => {
          packageManager = request.packageManager;
          return { status: 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'ready' }),
      },
    });
    await auto.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    expect(packageManager).toBe('auto');
  });

  it('retries idempotent port ensure when allocation succeeded but its lease state write failed', async () => {
    const value = fixture();
    let ensureCalls = 0;
    value.dependencies.ports.ensure = async () => {
      ensureCalls += 1;
      return { lease: { leaseId: 'lease-1' } };
    };
    const originalWrite = value.dependencies.state.writeAtomic;
    let failed = false;
    value.dependencies.state.writeAtomic = async (key, state) => {
      if (state.status === 'leased' && !failed) {
        failed = true;
        throw new Error('leased write failed');
      }
      await originalWrite(key, state);
    };
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toThrow('leased write failed');
    expect([...value.states.values()][0]).toMatchObject({ status: 'allocating' });
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).resolves.toMatchObject({ status: 'ready', leaseId: 'lease-1' });
    expect(ensureCalls).toBe(2);
  });

  it('leaves no lease when Git creation fails and preserves the worktree plus diagnostics when a later phase fails', async () => {
    let ensured = 0;
    const gitFailure = fixture({
      git: {
        run: async () => {
          throw new Error('git failed');
        },
        list: async () => [],
        isDirty: async () => false,
        isInUse: async () => false,
      },
    });
    await expect(
      gitFailure.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_CREATE_GIT_FAILED' });
    expect(gitFailure.events).not.toContain('ports:ensure');

    const late = fixture({
      ports: {
        ensure: async () => {
          ensured += 1;
          throw new Error('ports failed');
        },
        captureReleaseIdentity: async () => releaseIdentity(),
        releaseLinkedAfterRemoval: async () => ({}),
        reconcile: async () => ({ orphaned: [] }),
      },
    });
    await expect(
      late.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_CREATE_INCOMPLETE' });
    expect(ensured).toBe(1);
    expect(late.inventory()).toContainEqual(linked);
    expect([...late.states.values()][0]).toMatchObject({
      status: 'failed',
      failure: { phase: 'ports' },
    });
  });

  it('reconciles a preparation execution error before persisting lifecycle failure state', async () => {
    const configured = {
      ...config,
      worktrees: {
        postCreate: {
          execution: 'foreground' as const,
          steps: [{ id: 'verify', uses: 'executable' as const, argv: ['node'] }],
        },
      },
    };
    const value = fixture({
      repository: {
        resolve: async () => ({
          mainRoot: main,
          commonGitDirectory: `${main}/.git`,
          configPath: `${main}/mpxconfig.json`,
          config: configured,
        }),
      },
      preparation: {
        prepare: async (request) =>
          request.validateOnly
            ? { status: 'approved' }
            : (() => {
                throw new Error('spawn rejected');
              })(),
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'unknown' }),
      },
    });
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_CREATE_INCOMPLETE' });
    const state = [...value.states.values()][0];
    expect(state).toMatchObject({
      status: 'unknown',
      preparationStatus: 'unknown',
      failure: { phase: 'preparation', code: 'PREPARATION_UNKNOWN' },
    });
    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).resolves.toMatchObject({ status: 'unknown' });
  });
});

describe('worktree lifecycle safety and resume', () => {
  it('rejects a lifecycle state whose key is not derived from its repository and branch before create side effects', async () => {
    const value = fixture();
    const requestedKey = deriveLifecycleKey(value.repositoryIdentity, 'feature/issue-42');
    value.states.set(requestedKey, {
      schemaVersion: 1,
      owner: 'mpx',
      key: 'wrong-key',
      repositoryId: 'acme/widgets',
      repositoryIdentity: value.repositoryIdentity,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'failed',
      createdAt: 1,
      updatedAt: 2,
    });

    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_LIFECYCLE_STATE_INVALID' });
    expect(value.events).toEqual(['lock', 'unlock']);
  });

  it('validates every lifecycle identity before reconcile mutates preparation or ports', async () => {
    const invalid: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: 'wrong-key',
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'preparing',
      preparationStatus: 'preparing',
      createdAt: 1,
      updatedAt: 2,
    };
    const value = fixture({
      state: {
        load: async () => invalid,
        writeAtomic: async () => {
          value.events.push('state');
        },
        list: async () => [invalid],
      },
      preparation: {
        prepare: async () => ({ status: 'ready' }),
        cancel: async () => {
          value.events.push('cancel');
          return { status: 'cancelled' };
        },
        reconcile: async () => {
          value.events.push('preparation:reconcile');
          return { status: 'ready' };
        },
      },
      ports: {
        ensure: async () => ({}),
        captureReleaseIdentity: async () => releaseIdentity(),
        releaseLinkedAfterRemoval: async () => ({}),
        reconcile: async () => {
          value.events.push('ports:reconcile');
          return { orphaned: [] };
        },
      },
    });

    await expect(value.service.reconcile({ cwd: main })).rejects.toMatchObject({
      code: 'WORKTREE_LIFECYCLE_STATE_INVALID',
    });
    expect(value.events).toEqual(['lock', 'unlock']);
  });

  it.each([
    ['missing inventory', undefined, 'ready'],
    ['reused path with a different branch', 'other-branch', 'ready'],
  ] as const)(
    'fails closed for an existing %s state',
    async (_description, inventoryBranch, status) => {
      const value = fixture(
        inventoryBranch === undefined
          ? {}
          : {
              git: {
                run: async () => Buffer.alloc(0),
                list: async () => [{ ...linked, branch: inventoryBranch }],
                isDirty: async () => false,
                isInUse: async () => false,
              },
            },
      );
      const key = deriveLifecycleKey(value.repositoryIdentity, 'feature/issue-42');
      value.states.set(key, {
        schemaVersion: 1,
        owner: 'mpx',
        key,
        repositoryId: 'acme/widgets',
        repositoryIdentity: value.repositoryIdentity,
        mainRoot: main,
        worktreePath: target,
        branch: 'feature/issue-42',
        base: 'durable-base',
        configHash: 'hash',
        status,
        createdAt: 1,
        updatedAt: 2,
      });
      await expect(
        value.service.create({ cwd: main, branch: 'feature/issue-42' }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/WORKTREE_(?:LIFECYCLE_INVENTORY|RESUME_BRANCH)_MISMATCH/u),
      });
    },
  );

  it.each(['approval-required', 'failed'] as const)(
    'resumes a %s state with its durable base',
    async (status) => {
      let remoteDiscovery = 0;
      const value = fixture({
        git: {
          run: async (args) => {
            if (args[0] === 'symbolic-ref') {
              remoteDiscovery += 1;
            }
            return Buffer.alloc(0);
          },
          list: async () => [linked],
          isDirty: async () => false,
          isInUse: async () => false,
        },
      });
      const key = deriveLifecycleKey(value.repositoryIdentity, 'feature/issue-42');
      value.states.set(key, {
        schemaVersion: 1,
        owner: 'mpx',
        key,
        repositoryId: 'acme/widgets',
        repositoryIdentity: value.repositoryIdentity,
        mainRoot: main,
        worktreePath: target,
        branch: 'feature/issue-42',
        base: 'durable-base',
        configHash: 'hash',
        status,
        createdAt: 1,
        updatedAt: 2,
      });
      const result = await value.service.create({ cwd: main, branch: 'feature/issue-42' });
      expect(result.state?.base).toBe('durable-base');
      expect(remoteDiscovery).toBe(0);
    },
  );

  it('defaults include sourceRoot to the invoking checkout root', async () => {
    let sourceRoot: string | undefined;
    const currentRoot = `${main}.worktrees/current`;
    const value = fixture({
      repository: {
        resolve: async () => ({
          currentRoot,
          mainRoot: main,
          commonGitDirectory: value.repositoryIdentity,
          configPath: `${main}/mpxconfig.json`,
          config,
        }),
      },
      includes: {
        copy: async (request) => {
          sourceRoot = request.sourceRoot;
        },
      },
    });
    await value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    expect(sourceRoot).toBe(currentRoot);
  });

  it('reconciles a durable allocation intent by idempotently ensuring and attaching its lease', async () => {
    const state: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'feature/issue-42'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'allocating',
      createdAt: 1,
      updatedAt: 2,
    };
    let ensures = 0;
    const value = fixture({
      git: {
        run: async () => Buffer.alloc(0),
        list: async () => [linked],
        isDirty: async () => false,
        isInUse: async () => false,
      },
      state: {
        load: async () => state,
        writeAtomic: async (_key, next) => {
          Object.assign(state, structuredClone(next));
        },
        list: async () => [state],
      },
      ports: {
        ensure: async (request) => {
          ensures += 1;
          expect(request.configHash).toBe(state.configHash);
          return { lease: { leaseId: 'existing-lease' } };
        },
        captureReleaseIdentity: async () => releaseIdentity(),
        releaseLinkedAfterRemoval: async () => ({}),
        reconcile: async () => ({ orphaned: [] }),
      },
    });
    await value.service.reconcile({ cwd: main });
    expect(ensures).toBe(1);
    expect(state).toMatchObject({ status: 'ready', leaseId: 'existing-lease' });
  });

  it('persists unknown preparation diagnostics after external deletion and still reconciles port orphans', async () => {
    let portsReconciled = false;
    const state: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'gone'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: `${main}.worktrees/gone`,
      branch: 'gone',
      base: 'main',
      configHash: 'hash',
      status: 'preparing',
      preparationStatus: 'preparing',
      createdAt: 1,
      updatedAt: 2,
    };
    const value = fixture({
      state: {
        load: async () => state,
        writeAtomic: async (_key, next) => {
          Object.assign(state, structuredClone(next));
        },
        list: async () => [state],
      },
      preparation: {
        prepare: async () => ({ status: 'ready' }),
        cancel: async () => {
          throw new MpxError({
            code: 'PREPARATION_STATE_MISSING',
            message: 'Preparation state does not exist.',
          });
        },
        reconcile: async () => ({ status: 'ready' }),
      },
      ports: {
        ensure: async () => ({}),
        captureReleaseIdentity: async () => releaseIdentity(),
        releaseLinkedAfterRemoval: async () => ({}),
        reconcile: async () => {
          portsReconciled = true;
          return { orphaned: [{ leaseId: 'orphan' }] };
        },
      },
    });
    await value.service.reconcile({ cwd: main });
    expect(state).toMatchObject({
      externalDeletion: true,
      status: 'unknown',
      preparationStatus: 'unknown',
      failure: { phase: 'remove', code: 'PREPARATION_STATE_MISSING' },
    });
    expect(portsReconciled).toBe(true);
  });
});

describe('worktree lifecycle remove and reconcile', () => {
  it('fails closed for detached inventory without repository-and-branch lifecycle identity', async () => {
    const { branch: _branch, ...linkedWithoutBranch } = linked;
    const detached: WorktreeInventoryEntry = { ...linkedWithoutBranch, detached: true };
    const value = fixture({
      git: {
        run: async (args) => {
          value.events.push(`git:${args.join('|')}`);
          return Buffer.alloc(0);
        },
        list: async () => [detached],
        isDirty: async () => false,
        isInUse: async () => false,
      },
    });

    await expect(value.service.remove({ cwd: main, worktreePath: target })).rejects.toMatchObject({
      code: 'WORKTREE_LIFECYCLE_IDENTITY_REQUIRED',
    });
    expect(value.events).toEqual(['lock', 'unlock']);
  });

  it('treats a prunable inventory entry as externally deleted during fresh reconciliation', async () => {
    const state: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'gone'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'gone',
      base: 'main',
      configHash: 'hash',
      status: 'ready',
      createdAt: 1,
      updatedAt: 2,
    };
    const value = fixture({
      git: {
        run: async () => Buffer.alloc(0),
        list: async () => [
          { ...linked, branch: 'gone', prunable: 'gitdir file points to non-existent location' },
        ],
        isDirty: async () => false,
        isInUse: async () => false,
      },
      state: {
        load: async () => state,
        writeAtomic: async (_key, next) => {
          Object.assign(state, structuredClone(next));
        },
        list: async () => [state],
      },
    });
    await value.service.reconcile({ cwd: main });
    expect(state).toMatchObject({ status: 'orphaned', externalDeletion: true });
  });

  it('reconciles persisted terminal preparation before acting on a preparation-pending lifecycle', async () => {
    const pending: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'feature/issue-42'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'preparation-pending',
      createdAt: 1,
      updatedAt: 2,
      leaseId: 'lease-1',
      includeEvidence: { manifestSha256: 'manifest', completed: true },
    };
    let runs = 0;
    const value = fixture({
      git: {
        run: async () => Buffer.alloc(0),
        list: async () => [linked],
        isDirty: async () => false,
        isInUse: async () => false,
      },
      state: {
        load: async () => pending,
        writeAtomic: async (_key, next) => {
          Object.assign(pending, structuredClone(next));
        },
        list: async () => [pending],
      },
      preparation: {
        prepare: async (request) => {
          if (!request.validateOnly) {
            runs += 1;
          }
          return { status: 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'failed' }),
      },
    });

    await value.service.reconcile({ cwd: main });

    expect(runs).toBe(0);
    expect(pending).toMatchObject({
      status: 'failed',
      preparationStatus: 'failed',
      failure: { phase: 'preparation' },
    });
  });

  it('keeps a preparation-pending lifecycle active when persisted preparation is still preparing', async () => {
    const pending: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'feature/issue-42'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'preparation-pending',
      createdAt: 1,
      updatedAt: 2,
      leaseId: 'lease-1',
    };
    let runs = 0;
    const value = fixture({
      git: {
        run: async () => Buffer.alloc(0),
        list: async () => [linked],
        isDirty: async () => false,
        isInUse: async () => false,
      },
      state: {
        load: async () => pending,
        writeAtomic: async (_key, next) => {
          Object.assign(pending, structuredClone(next));
        },
        list: async () => [pending],
      },
      preparation: {
        prepare: async () => {
          runs += 1;
          return { status: 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'preparing' }),
      },
    });

    await value.service.reconcile({ cwd: main });

    expect(pending).toMatchObject({ status: 'preparing', preparationStatus: 'preparing' });
    expect(runs).toBe(0);
  });

  it('starts the approved preparation exactly once when lifecycle says preparing but engine state is missing', async () => {
    const preparing: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'feature/issue-42'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'preparing',
      createdAt: 1,
      updatedAt: 2,
      leaseId: 'lease-1',
      includeEvidence: { manifestSha256: 'manifest', completed: true },
      preparationEvidence: { planDigest: 'placeholder' },
    };
    let runs = 0;
    const value = fixture({
      git: {
        run: async () => Buffer.alloc(0),
        list: async () => [linked],
        isDirty: async () => false,
        isInUse: async () => false,
      },
      state: {
        load: async () => preparing,
        writeAtomic: async (_key, next) => {
          Object.assign(preparing, structuredClone(next));
        },
        list: async () => [preparing],
      },
      preparation: {
        prepare: async (request) => {
          if (!request.validateOnly) {
            runs += 1;
          }
          return { status: request.validateOnly ? 'approved' : 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => {
          throw new MpxError({ code: 'PREPARATION_STATE_MISSING', message: 'missing' });
        },
      },
    });
    // Adopt the current request digest as old persisted evidence would have done.
    delete preparing.preparationEvidence;
    await value.service.reconcile({ cwd: main });
    expect(runs).toBe(1);
    expect(preparing).toMatchObject({ status: 'ready', preparationStatus: 'ready' });
  });

  it('does not automatically retry a terminal failed preparation during create', async () => {
    const failed: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'feature/issue-42'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'failed',
      createdAt: 1,
      updatedAt: 2,
      leaseId: 'lease-1',
      includeEvidence: { manifestSha256: 'manifest', completed: true },
      preparationStatus: 'failed',
      failure: { phase: 'preparation', code: 'PREPARATION_FAILED', message: 'failed' },
    };
    let runs = 0;
    const value = fixture({
      git: {
        run: async () => Buffer.alloc(0),
        list: async () => [linked],
        isDirty: async () => false,
        isInUse: async () => false,
      },
      state: {
        load: async () => failed,
        writeAtomic: async (_key, next) => {
          Object.assign(failed, structuredClone(next));
        },
      },
      preparation: {
        prepare: async () => {
          runs += 1;
          return { status: 'ready' };
        },
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'failed' }),
      },
    });

    await expect(
      value.service.create({ cwd: main, branch: 'feature/issue-42' }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(runs).toBe(0);
  });

  it('maps preparation reconcile unknown to a safe unknown status after restart', async () => {
    const preparing: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'feature/issue-42'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'preparing',
      createdAt: 1,
      updatedAt: 2,
      preparationStatus: 'preparing',
    };
    const value = fixture({
      git: {
        run: async () => Buffer.alloc(0),
        list: async () => [linked],
        isDirty: async () => false,
        isInUse: async () => false,
      },
      state: {
        load: async () => preparing,
        writeAtomic: async (_key, state) => {
          Object.assign(preparing, state);
        },
        list: async () => [preparing],
      },
      preparation: {
        prepare: async () => ({ status: 'ready' }),
        cancel: async () => ({ status: 'cancelled' }),
        reconcile: async () => ({ status: 'unknown' }),
      },
    });
    await value.service.reconcile({ cwd: main });
    expect(preparing).toMatchObject({ status: 'unknown', preparationStatus: 'unknown' });
  });

  it('refuses removal when preparation cancellation stays unknown and preserves the git worktree and lease', async () => {
    const preparing: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'feature/issue-42'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'preparing',
      createdAt: 1,
      updatedAt: 2,
      leaseId: 'lease-1',
      preparationStatus: 'preparing',
    };
    const value = fixture({
      git: {
        run: async (args) => {
          value.events.push(`git:${args.join('|')}`);
          return Buffer.alloc(0);
        },
        list: async () => [linked],
        isDirty: async () => false,
        isInUse: async () => false,
      },
      state: {
        load: async () => preparing,
        writeAtomic: async (_key, state) => {
          Object.assign(preparing, structuredClone(state));
          value.events.push(`state:${state.status}`);
        },
      },
      preparation: {
        prepare: async () => ({ status: 'ready' }),
        cancel: async () => ({ status: 'unknown' }),
        reconcile: async () => ({ status: 'ready' }),
      },
    });
    await expect(value.service.remove({ cwd: main, worktreePath: target })).rejects.toMatchObject({
      code: 'WORKTREE_REMOVE_PREPARATION_UNKNOWN',
    });
    expect(value.events).toEqual(['lock', 'state:preparing', 'unlock']);
    expect(preparing.leaseId).toBe('lease-1');
  });

  it('cancels an owned preparation worker before checking remaining external usage', async () => {
    const preparing: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'feature/issue-42'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: target,
      branch: 'feature/issue-42',
      base: 'main',
      configHash: 'hash',
      status: 'preparing',
      createdAt: 1,
      updatedAt: 2,
      leaseId: 'lease-1',
      preparationStatus: 'preparing',
    };
    let external = true;
    const value = fixture({
      git: {
        run: async (args) => {
          value.events.push(`git:${args.join('|')}`);
          return Buffer.alloc(0);
        },
        list: async () => [linked],
        isDirty: async () => false,
        isInUse: async () => {
          value.events.push('external-use');
          return external;
        },
      },
      state: {
        load: async () => preparing,
        writeAtomic: async (_key, state) => {
          Object.assign(preparing, structuredClone(state));
          value.events.push(`state:${state.status}`);
        },
      },
      preparation: {
        prepare: async () => ({ status: 'ready' }),
        cancel: async () => {
          value.events.push('cancel');
          external = false;
          return { status: 'cancelled' };
        },
        reconcile: async () => ({ status: 'ready' }),
      },
    });
    await expect(value.service.remove({ cwd: main, worktreePath: target })).resolves.toMatchObject({
      status: 'removed',
    });
    expect(value.events.indexOf('cancel')).toBeLessThan(value.events.indexOf('external-use'));
  });

  it('persists identity-bound removal phases and retries release after a fresh-process reconcile', async () => {
    const value = fixture();
    await value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    const identity = {
      schemaVersion: 1 as const,
      leaseId: 'lease-1',
      projectId: 'acme/widgets',
      repositoryId: 'repository',
      worktreeId: 'worktree',
      worktreePath: target,
      role: 'linked' as const,
      configHash: 'hash',
    };
    value.dependencies.ports.captureReleaseIdentity = async () => identity;
    let releases = 0;
    value.dependencies.ports.releaseLinkedAfterRemoval = async (request) => {
      releases += 1;
      expect(request.identity).toEqual(identity);
      if (releases === 1) {
        throw new Error('registry unavailable');
      }
      return { released: true };
    };
    await expect(value.service.remove({ cwd: main, worktreePath: target })).rejects.toMatchObject({
      code: 'WORKTREE_REMOVE_RELEASE_FAILED',
    });
    expect([...value.states.values()][0]).toMatchObject({
      status: 'git-removed-awaiting-lease-release',
      releaseIdentity: identity,
    });

    value.dependencies.state.list = async () => [...value.states.values()];
    await value.service.reconcile({ cwd: main });
    expect(releases).toBe(2);
    expect([...value.states.values()][0]).toMatchObject({
      status: 'removed',
      releaseIdentity: identity,
    });
  });

  it('does not mutate Git when the pre-removal identity state write fails', async () => {
    const value = fixture();
    await value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    value.events.length = 0;
    value.dependencies.state.writeAtomic = async (_key, state) => {
      value.events.push(`state:${state.status}`);
      if (state.status === 'removing') {
        throw new Error('state unavailable');
      }
    };
    await expect(value.service.remove({ cwd: main, worktreePath: target })).rejects.toThrow(
      'state unavailable',
    );
    expect(value.events).not.toContain(`git:worktree|remove|${target}`);
    expect(value.events).not.toContain('ports:release');
  });

  it('recovers when persisting the post-Git awaiting-release phase fails', async () => {
    const value = fixture();
    await value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    const originalWrite = value.dependencies.state.writeAtomic;
    let failed = false;
    value.dependencies.state.writeAtomic = async (key, state) => {
      if (state.status === 'git-removed-awaiting-lease-release' && !failed) {
        failed = true;
        throw new Error('awaiting write failed');
      }
      await originalWrite(key, state);
    };
    await expect(value.service.remove({ cwd: main, worktreePath: target })).rejects.toThrow(
      'awaiting write failed',
    );
    expect([...value.states.values()][0]).toMatchObject({
      status: 'removing',
      releaseIdentity: { leaseId: 'lease-1' },
    });
    value.dependencies.state.list = async () => [...value.states.values()];
    await value.service.reconcile({ cwd: main });
    expect(value.events.filter((event) => event === 'ports:release')).toHaveLength(1);
    expect([...value.states.values()][0]).toMatchObject({ status: 'removed' });
  });

  it('retries the exact release when the final removed-state write fails', async () => {
    const value = fixture();
    await value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    const originalWrite = value.dependencies.state.writeAtomic;
    let finalWrites = 0;
    value.dependencies.state.writeAtomic = async (key, state) => {
      if (state.status === 'removed' && finalWrites++ === 0) {
        throw new Error('final write failed');
      }
      await originalWrite(key, state);
    };
    await expect(value.service.remove({ cwd: main, worktreePath: target })).rejects.toThrow(
      'final write failed',
    );
    expect([...value.states.values()][0]).toMatchObject({
      status: 'git-removed-awaiting-lease-release',
      releaseIdentity: { leaseId: 'lease-1' },
    });
    value.dependencies.state.list = async () => [...value.states.values()];
    await value.service.reconcile({ cwd: main });
    expect(value.events.filter((event) => event === 'ports:release')).toHaveLength(2);
    expect([...value.states.values()][0]).toMatchObject({ status: 'removed' });
  });

  it('preserves the identity-bound lease when non-forced Git removal fails', async () => {
    const value = fixture();
    await value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    value.dependencies.git.run = async (args) => {
      value.events.push(`git:${args.join('|')}`);
      throw new Error('git remove failed');
    };
    await expect(value.service.remove({ cwd: main, worktreePath: target })).rejects.toMatchObject({
      code: 'WORKTREE_REMOVE_GIT_FAILED',
    });
    expect([...value.states.values()][0]).toMatchObject({
      status: 'removing',
      releaseIdentity: { leaseId: 'lease-1' },
      failure: { phase: 'remove' },
    });
    expect(value.events).not.toContain('ports:release');
  });

  it('captures the immutable lease, refuses unsafe inventory, and releases only after non-forced Git removal', async () => {
    const value = fixture();
    await value.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    value.events.length = 0;
    const result = await value.service.remove({ cwd: main, worktreePath: target });
    expect(result).toMatchObject({ operation: 'remove', status: 'removed', released: true });
    expect(value.events).toEqual([
      'lock',
      'ports:capture',
      'state:removing',
      `git:worktree|remove|${target}`,
      'state:git-removed-awaiting-lease-release',
      'ports:release',
      'state:removed',
      'unlock',
    ]);

    const locked = fixture({
      git: {
        run: async () => Buffer.alloc(0),
        list: async () => [{ ...linked, locked: true }],
        isDirty: async () => false,
        isInUse: async () => false,
      },
    });
    await expect(locked.service.remove({ cwd: main, worktreePath: target })).rejects.toMatchObject({
      code: 'WORKTREE_REMOVE_LOCKED',
    });
  });

  it('refuses dirty worktree removal before any git deletion', async () => {
    const value = fixture({
      git: {
        run: async (args) => {
          value.events.push(`git:${args.join('|')}`);
          return Buffer.alloc(0);
        },
        list: async () => [linked],
        isDirty: async () => true,
        isInUse: async () => false,
      },
    });
    await expect(value.service.remove({ cwd: main, worktreePath: target })).rejects.toMatchObject({
      code: 'WORKTREE_REMOVE_DIRTY',
    });
    expect(value.events).toEqual(['lock', 'unlock']);
  });

  it('reports externally deleted worktrees as explicit port orphans without discarding failure history', async () => {
    const failed: LifecycleState = {
      schemaVersion: 1,
      owner: 'mpx',
      key: deriveLifecycleKey(`${main}/.git`, 'gone'),
      repositoryId: 'acme/widgets',
      repositoryIdentity: `${main}/.git`,
      mainRoot: main,
      worktreePath: `${main}.worktrees/gone`,
      branch: 'gone',
      base: 'main',
      configHash: 'hash',
      status: 'failed',
      createdAt: 1,
      updatedAt: 2,
      failure: { phase: 'preparation', code: 'boom', message: 'failed' },
    };
    const value = fixture({
      state: {
        load: async () => failed,
        writeAtomic: async (_key, state) => {
          Object.assign(failed, state);
        },
        list: async () => [failed],
      },
      ports: {
        ensure: async () => ({}),
        captureReleaseIdentity: async () => releaseIdentity(),
        releaseLinkedAfterRemoval: async () => ({}),
        reconcile: async () => ({ orphaned: [{ leaseId: 'orphan' }] }),
      },
    });
    const result = await value.service.reconcile({ cwd: main });
    expect(result).toMatchObject({
      operation: 'reconcile',
      status: 'reconciled',
      orphaned: [{ leaseId: 'orphan' }],
    });
    expect(failed.failure).toEqual({ phase: 'preparation', code: 'boom', message: 'failed' });
    expect(failed.externalDeletion).toBe(true);
  });

  it('keeps lifecycle keys isolated for different canonical repositories that share a project id and branch', async () => {
    const states = new Map<string, LifecycleState>();
    const state = {
      load: async (key: string) => states.get(key),
      writeAtomic: async (key: string, value: LifecycleState) => {
        states.set(key, structuredClone(value));
      },
    };
    const first = fixture({ state });
    const otherMain = 'C:/other repo';
    const otherRepositoryIdentity = `${otherMain}/.git`;
    const second = fixture({
      state,
      repository: {
        resolve: async () => ({
          mainRoot: otherMain,
          commonGitDirectory: otherRepositoryIdentity,
          configPath: `${otherMain}/mpxconfig.json`,
          config,
        }),
      },
    });

    await first.service.create({ cwd: main, branch: 'feature/issue-42', base: 'main' });
    await second.service.create({ cwd: otherMain, branch: 'feature/issue-42', base: 'main' });

    const entries = [...states.entries()];
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map(([key]) => key)).size).toBe(2);
    expect(entries.map(([, value]) => value.repositoryIdentity).sort()).toEqual(
      [first.repositoryIdentity, otherRepositoryIdentity].sort(),
    );
  });
});
