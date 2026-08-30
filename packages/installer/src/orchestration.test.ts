import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type InstallIntentV1,
  type InstallOperationV1,
  type ScheduledTaskStatusEvidenceV1,
} from './immutable-core.js';
import { MemoryTransactionStore, installerDigest } from './transaction.js';
import {
  InstallOrchestrator,
  NodeCurrentReleaseBuilder,
  type InstallerOperationAdapter,
} from './orchestration.js';
import type { InstallExternalVerificationResultV1 } from './install-intent-builder.js';

class FixtureAdapter implements InstallerOperationAdapter {
  readonly name = 'fixture';
  readonly values = new Map<string, string>();
  applyCalls: string[] = [];
  statusCalls: string[] = [];
  taskStatus: ScheduledTaskStatusEvidenceV1 | undefined;
  constructor(
    readonly automatic: readonly InstallOperationV1[],
    readonly scheduled: readonly InstallOperationV1[] = [],
  ) {}
  async operations() {
    return { automatic: this.automatic, scheduled: this.scheduled };
  }
  async inspectScheduledTaskStatus(operation: InstallOperationV1) {
    this.statusCalls.push(operation.id);
    return this.scheduled.some((item) => item.id === operation.id) ? this.taskStatus : undefined;
  }
  async observe(operation: InstallOperationV1) {
    return this.values.get(operation.target) ?? null;
  }
  async capture(operation: InstallOperationV1) {
    return this.values.get(operation.target) ?? null;
  }
  async apply(operation: InstallOperationV1) {
    this.applyCalls.push(operation.id);
    if (operation.action === 'remove') {
      this.values.delete(operation.target);
    } else {
      this.values.set(operation.target, operation.desiredDigest!);
    }
  }
  async restore(operation: InstallOperationV1, snapshot: string | null) {
    if (snapshot === null) {
      this.values.delete(operation.target);
    } else {
      this.values.set(operation.target, snapshot);
    }
  }
}
async function fixture() {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'mpx-orchestrator-repo-'));
  const appsRoot = await mkdtemp(path.join(tmpdir(), 'mpx-orchestrator-apps-'));
  await mkdir(path.join(repositoryRoot, 'dist'));
  await writeFile(path.join(repositoryRoot, 'dist', 'mpx.js'), 'current-release');
  const builder = new NodeCurrentReleaseBuilder({ repositoryRoot, appsRoot, assetPaths: ['dist'] });
  const manifest = await builder.build();
  const intent: InstallIntentV1 = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey: manifest.releaseKey,
    convergenceHash: manifest.convergenceHash,
    components: ['cli'],
  };
  return { repositoryRoot, appsRoot, builder, manifest, intent };
}
const operation = (id: string, target = id): InstallOperationV1 => ({
  id,
  adapter: 'fixture',
  action: 'ensure',
  target,
  desiredDigest: installerDigest(id),
});

describe('Phase I install orchestration', () => {
  it('plans the current deterministic release without publishing or applying', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('automatic')]);
    const orchestrator = new InstallOrchestrator({
      adapter,
      store: new MemoryTransactionStore(),
      releases: f.builder,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });
    const plan = await orchestrator.plan(f.intent);
    expect(plan.intent).toEqual(f.intent);
    expect(adapter.applyCalls).toEqual([]);
    await expect(
      readFile(path.join(f.appsRoot, 'mpx', 'releases', f.manifest.releaseKey, 'dist', 'mpx.js')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('activates the immutable release only after every apply side effect succeeds', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')], [operation('90-scheduled')]),
      events: string[] = [];
    const originalApply = adapter.apply.bind(adapter);
    adapter.apply = async (operation) => {
      events.push(operation.id);
      await originalApply(operation);
    };
    const orchestrator = new InstallOrchestrator({
      adapter,
      store: new MemoryTransactionStore(),
      releases: f.builder,
      activate: async (releaseKey) => {
        events.push(`active:${releaseKey}`);
        return async () => {};
      },
    });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    expect(events).toEqual(['10-automatic', '90-scheduled', `active:${f.manifest.releaseKey}`]);
  });

  it('rolls back committed operations and selector when activation fails', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      store = new MemoryTransactionStore(),
      events: string[] = [];
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      activate: async () => {
        events.push('activate');
        throw new Error('activation failed');
      },
      deactivate: async () => {
        events.push('deactivate');
      },
    });
    const plan = await orchestrator.plan(f.intent);
    await expect(orchestrator.apply(plan, plan.confirmationDigest)).rejects.toThrow(
      'activation failed',
    );
    expect(adapter.values.size).toBe(0);
    expect(await store.readReceipt()).toBeUndefined();
    expect((await store.readTransaction())?.journal.phase).toBe('rolled-back');
    expect(events).toEqual(['activate']);
  });

  it('aggregates selector and service rollback failures behind the primary post-activation failure', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      store = new MemoryTransactionStore();
    adapter.restore = async () => {
      throw new Error('service rollback failed');
    };
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      activate: async () => {
        adapter.values.set('10-automatic', 'drifted');
        return async () => {
          throw new Error('selector rollback failed');
        };
      },
    });
    const plan = await orchestrator.plan(f.intent);
    const failure = await orchestrator
      .apply(plan, plan.confirmationDigest)
      .catch((error) => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure.cause as { code: string }).code).toBe('INSTALL_POST_ACTIVATION_VERIFY_FAILED');
    expect(failure.errors.map((error) => (error as Error).message)).toEqual([
      'Activated installation failed actual-state verification.',
      'selector rollback failed',
      'service rollback failed',
    ]);
  });

  it('does not expose a release when a committed operation fails actual-state verification', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      activated: string[] = [];
    const baseObserve = adapter.observe.bind(adapter);
    let corruptAfterApply = false;
    adapter.apply = async (item) => {
      adapter.applyCalls.push(item.id);
      adapter.values.set(item.target, item.desiredDigest!);
      corruptAfterApply = true;
    };
    adapter.observe = async (target) =>
      corruptAfterApply ? installerDigest('post-commit-drift') : baseObserve(target);
    const orchestrator = new InstallOrchestrator({
      adapter,
      store: new MemoryTransactionStore(),
      releases: f.builder,
      activate: async (key) => {
        activated.push(key);
        return async () => {};
      },
    });
    const plan = await orchestrator.plan(f.intent);
    await expect(orchestrator.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({
      code: 'INSTALL_POST_COMMIT_VERIFY_FAILED',
    });
    expect(activated).toEqual([]);
  });

  it('publishes before automatic operations, schedules last, and converges idempotently', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')], [operation('90-scheduled')]),
      store = new MemoryTransactionStore();
    const originalApply = adapter.apply.bind(adapter);
    adapter.apply = async (operation) => {
      expect(
        await readFile(
          path.join(f.appsRoot, 'mpx', 'releases', f.manifest.releaseKey, 'dist', 'mpx.js'),
          'utf8',
        ),
      ).toBe('current-release');
      await originalApply(operation);
    };
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });
    const firstPlan = await orchestrator.plan(f.intent);
    const first = await orchestrator.apply(firstPlan, firstPlan.confirmationDigest);
    expect(adapter.applyCalls).toEqual(['10-automatic', '90-scheduled']);
    const secondPlan = await orchestrator.plan(f.intent);
    const second = await orchestrator.apply(secondPlan, secondPlan.confirmationDigest);
    expect(second).toEqual(first);
    expect(adapter.applyCalls).toEqual(['10-automatic', '90-scheduled']);
  });

  it('verifies actual release and operation state rather than trusting receipts', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });
    const clean = await orchestrator.verify();
    expect(clean).toMatchObject({ healthy: false, issues: ['receipt-missing'] });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    expect(await orchestrator.verify()).toMatchObject({ healthy: true, issues: [] });
    adapter.values.set('10-automatic', 'tampered');
    await writeFile(
      path.join(f.appsRoot, 'mpx', 'releases', f.manifest.releaseKey, 'dist', 'mpx.js'),
      'tampered',
    );
    expect(await orchestrator.verify()).toMatchObject({
      healthy: false,
      issues: ['operation-drift:10-automatic', 'release-file-drift:dist/mpx.js'],
    });
  });

  it('returns healthy structured evidence after the managed scheduled task has run successfully', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([], [operation('90-scheduled-capture')]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      now: () => new Date('2024-12-31T23:59:59.000Z'),
    });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    expect(adapter.statusCalls).toEqual([]);
    adapter.taskStatus = {
      exists: true,
      state: 'Ready',
      lastRunAt: '2025-01-01T00:00:00.000Z',
      lastResult: 0,
      nextRunAt: '2025-01-01T00:05:00.000Z',
    };
    await expect(orchestrator.verify()).resolves.toMatchObject({
      healthy: true,
      issues: [],
      scheduledTask: {
        id: '90-scheduled-capture',
        target: '90-scheduled-capture',
        status: 'healthy',
        exists: true,
        state: 'Ready',
        lastRunAt: '2025-01-01T00:00:00.000Z',
        lastResult: 0,
        nextRunAt: '2025-01-01T00:05:00.000Z',
      },
    });
  });

  it('rejects zero-result scheduled-task evidence that predates the ownership receipt', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([], [operation('90-scheduled-capture')]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      now: () => new Date('2025-01-02T00:00:00.000Z'),
    });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    adapter.taskStatus = {
      exists: true,
      state: 'Ready',
      lastRunAt: '2025-01-01T23:59:59.000Z',
      lastResult: 0,
    };
    await expect(orchestrator.verify()).resolves.toMatchObject({
      healthy: false,
      issues: ['scheduled-task-run-predates-install:90-scheduled-capture'],
      scheduledTask: { status: 'not-run', lastResult: 0 },
    });
  });

  it('reports a missing managed scheduled task as unhealthy structured evidence', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([], [operation('90-scheduled-capture')]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    adapter.taskStatus = { exists: false };
    await expect(orchestrator.verify()).resolves.toMatchObject({
      healthy: false,
      issues: ['scheduled-task-missing:90-scheduled-capture'],
      scheduledTask: {
        id: '90-scheduled-capture',
        status: 'missing',
        exists: false,
        lastRunAt: null,
        lastResult: null,
      },
    });
  });

  it('fails closed when scheduled-task status inspection is unavailable', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([], [operation('90-scheduled-capture')]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    (
      adapter as { inspectScheduledTaskStatus?: FixtureAdapter['inspectScheduledTaskStatus'] }
    ).inspectScheduledTaskStatus = undefined;
    await expect(orchestrator.verify()).resolves.toMatchObject({
      healthy: false,
      issues: ['scheduled-task-status-unavailable:90-scheduled-capture'],
    });
  });

  it('reports an installed managed scheduled task with no run evidence as unhealthy', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([], [operation('90-scheduled-capture')]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    adapter.taskStatus = { exists: true, state: 'Ready' };
    await expect(orchestrator.verify()).resolves.toMatchObject({
      healthy: false,
      issues: ['scheduled-task-not-run:90-scheduled-capture'],
      scheduledTask: {
        id: '90-scheduled-capture',
        status: 'not-run',
        exists: true,
        lastRunAt: null,
        lastResult: null,
      },
    });
  });

  it('reports a nonzero managed scheduled task result as unhealthy', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([], [operation('90-scheduled-capture')]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      now: () => new Date('2024-12-31T23:59:59.000Z'),
    });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    adapter.taskStatus = {
      exists: true,
      state: 'Ready',
      lastRunAt: '2025-01-01T00:00:00.000Z',
      lastResult: 1,
    };
    await expect(orchestrator.verify()).resolves.toMatchObject({
      healthy: false,
      issues: ['scheduled-task-failed:90-scheduled-capture:1'],
      scheduledTask: { id: '90-scheduled-capture', status: 'failed', exists: true, lastResult: 1 },
    });
  });

  it('does not inspect native or external state when the ownership receipt is missing', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([], [operation('90-scheduled-capture')]);
    let externalCalls = 0;
    const result = await new InstallOrchestrator({
      adapter,
      store: new MemoryTransactionStore(),
      releases: f.builder,
    }).verify(false, async () => {
      externalCalls++;
      throw new Error('external inspection forbidden');
    });
    expect(result).toMatchObject({ healthy: false, issues: ['receipt-missing'] });
    expect(adapter.statusCalls).toEqual([]);
    expect(externalCalls).toBe(0);
  });

  it('fails verification when the current scheduled operation is absent from the receipt', async () => {
    const f = await fixture(),
      scheduled = operation('90-scheduled-capture'),
      adapter = new FixtureAdapter([], [scheduled]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const receipt = (await store.readReceipt())!;
    await store.writeReceipt({ ...receipt, operations: [], operationLocators: [] });
    await expect(orchestrator.verify()).resolves.toMatchObject({
      healthy: false,
      issues: ['scheduled-operation-drift:90-scheduled-capture'],
    });
  });

  it('recomposes production operations from the receipt in a fresh verify process', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      installed = new FixtureAdapter([operation('10-automatic')]);
    const first = new InstallOrchestrator({ adapter: installed, store, releases: f.builder });
    const plan = await first.plan(f.intent);
    await first.apply(plan, plan.confirmationDigest);
    let composed = false;
    const fresh = new FixtureAdapter([operation('10-automatic')]);
    const baseOperations = fresh.operations.bind(fresh),
      baseObserve = fresh.observe.bind(fresh);
    fresh.operations = async () => {
      composed = true;
      return baseOperations();
    };
    fresh.observe = async (target) =>
      composed ? baseObserve(target) : Promise.reject(new Error('operations not composed'));
    fresh.values.set('10-automatic', installerDigest('10-automatic'));
    await expect(
      new InstallOrchestrator({ adapter: fresh, store, releases: f.builder }).verify(),
    ).resolves.toMatchObject({ healthy: true, issues: [] });
  });

  it('migrates a confirmed legacy v1 ownership receipt once and leaves a fresh process able to uninstall', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      store = new MemoryTransactionStore();
    await f.builder.publish(f.manifest.releaseKey);
    adapter.values.set('10-automatic', installerDigest('10-automatic'));
    await store.writeLegacyReceiptForMigration({
      schemaVersion: 1,
      kind: 'ownership-receipt',
      releaseKey: f.manifest.releaseKey,
      convergenceHash: f.manifest.convergenceHash,
      files: f.manifest.files,
      operations: [operation('10-automatic')],
      installedAt: '2024-01-01T00:00:00.000Z',
    });
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    await expect(orchestrator.verify()).rejects.toMatchObject({
      code: 'INSTALL_RECEIPT_MIGRATION_REQUIRED',
    });
    const plan = await orchestrator.plan(f.intent);
    expect(plan.classifications?.confirmationRequired).toContainEqual(
      expect.objectContaining({ id: 'ownership-receipt-v1-migration' }),
    );
    const migrated = await orchestrator.apply(plan, plan.confirmationDigest);
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      installedAt: '2024-01-01T00:00:00.000Z',
      operationLocators: [{ operationId: '10-automatic' }],
    });
    const idempotentPlan = await orchestrator.plan(f.intent);
    await expect(
      orchestrator.apply(idempotentPlan, idempotentPlan.confirmationDigest),
    ).resolves.toEqual(migrated);
    const fresh = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const uninstall = await fresh.planUninstall();
    await expect(fresh.uninstall(uninstall.confirmationDigest)).resolves.toMatchObject({
      removed: true,
    });
  });

  it('fails closed instead of migrating a drifted legacy receipt', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      store = new MemoryTransactionStore();
    await f.builder.publish(f.manifest.releaseKey);
    adapter.values.set('10-automatic', installerDigest('drifted'));
    await store.writeLegacyReceiptForMigration({
      schemaVersion: 1,
      kind: 'ownership-receipt',
      releaseKey: f.manifest.releaseKey,
      convergenceHash: f.manifest.convergenceHash,
      files: f.manifest.files,
      operations: [operation('10-automatic')],
      installedAt: '2024-01-01T00:00:00.000Z',
    });
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    await expect(orchestrator.plan(f.intent)).rejects.toMatchObject({
      code: 'INSTALL_RECEIPT_MIGRATION_UNSAFE',
      message: expect.stringContaining('manual recovery'),
    });
  });

  it('strict verification reports foreign release entries without deleting them', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const foreign = path.join(f.appsRoot, 'mpx', 'releases', f.manifest.releaseKey, 'foreign.txt');
    await writeFile(foreign, 'native');
    expect(await orchestrator.verify(false)).toMatchObject({ healthy: true, issues: [] });
    expect(await orchestrator.verify(true)).toMatchObject({
      healthy: false,
      issues: ['foreign-release-entry:foreign.txt'],
    });
    expect(await readFile(foreign, 'utf8')).toBe('native');
  });

  it('refuses a same-name foreign target before publishing or mutation', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      store = new MemoryTransactionStore();
    const foreignDigest = installerDigest('foreign');
    adapter.values.set('10-automatic', foreignDigest);
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(f.intent);
    await expect(orchestrator.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({
      code: 'INSTALL_FOREIGN_OR_DRIFTED',
    });
    expect(adapter.values.get('10-automatic')).toBe(foreignDigest);
    await expect(
      readFile(path.join(f.appsRoot, 'mpx', 'releases', f.manifest.releaseKey, 'dist', 'mpx.js')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when receipt-bound external integrations have no live evidence', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([]),
      store = new MemoryTransactionStore(),
      planDigest = installerDigest('git-plan'),
      verifierRef = `git-remotes:origin:${planDigest}`;
    const intent: InstallIntentV1 = {
      ...f.intent,
      externalIntegrations: [
        {
          id: 'origin',
          adapter: 'git-remotes',
          classification: 'confirmation-required',
          planDigest,
          verifierRef,
        },
      ],
    };
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const result = await orchestrator.verify();
    expect(result).toMatchObject({
      healthy: false,
      issues: ['external-verification-required:origin'],
      externalIntegrations: [{ id: 'origin', status: 'verification-required' }],
    });
    expect(result.externalIntegrations?.[0]?.status).not.toBe('confirmed');
  });

  it('marks only exactly bound healthy external evidence verified', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([]),
      store = new MemoryTransactionStore(),
      planDigest = installerDigest('notes-plan'),
      verifierRef = `obsidian:notes:${planDigest}`;
    const intent: InstallIntentV1 = {
      ...f.intent,
      externalIntegrations: [
        {
          id: 'notes',
          adapter: 'obsidian',
          classification: 'confirmation-required',
          planDigest,
          verifierRef,
        },
      ],
    };
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const external: InstallExternalVerificationResultV1 = {
      schemaVersion: 1,
      kind: 'install-external-verification',
      integrations: [
        { id: 'notes', adapter: 'obsidian', planDigest, verifierRef, healthy: true, issues: [] },
      ],
    };
    await expect(orchestrator.verify(false, external)).resolves.toMatchObject({
      healthy: true,
      issues: [],
      externalIntegrations: [{ id: 'notes', status: 'verified' }],
    });
  });

  it('refuses stale digest or verifier bindings and exposes stable unhealthy external issues', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([]),
      store = new MemoryTransactionStore(),
      gitDigest = installerDigest('git-plan'),
      rayDigest = installerDigest('ray-plan');
    const intent: InstallIntentV1 = {
      ...f.intent,
      externalIntegrations: [
        {
          id: 'git',
          adapter: 'git-remotes',
          classification: 'confirmation-required',
          planDigest: gitDigest,
          verifierRef: `git-remotes:git:${gitDigest}`,
        },
        {
          id: 'ray',
          adapter: 'raycast',
          classification: 'manual-only',
          planDigest: rayDigest,
          verifierRef: `raycast:ray:${rayDigest}`,
        },
      ],
    };
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const external: InstallExternalVerificationResultV1 = {
      schemaVersion: 1,
      kind: 'install-external-verification',
      integrations: [
        {
          id: 'git',
          adapter: 'git-remotes',
          planDigest: installerDigest('stale'),
          verifierRef: `git-remotes:git:${gitDigest}`,
          healthy: true,
          issues: [],
        },
        {
          id: 'ray',
          adapter: 'raycast',
          planDigest: rayDigest,
          verifierRef: `raycast:ray:${rayDigest}`,
          healthy: false,
          issues: ['raycast-id-category-drift'],
        },
      ],
    };
    await expect(orchestrator.verify(false, external)).resolves.toMatchObject({
      healthy: false,
      issues: [
        'external-verification-required:git',
        'external-verification:ray:raycast-id-category-drift',
      ],
      externalIntegrations: [
        { id: 'git', status: 'verification-required' },
        { id: 'ray', status: 'unhealthy' },
      ],
    });
  });

  it('uninstalls only receipt-owned state with exact confirmation', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
      store = new MemoryTransactionStore();
    const deactivated: string[] = [];
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      deactivate: async (releaseKey) => {
        deactivated.push(releaseKey);
      },
    });
    await expect(orchestrator.uninstall('x')).rejects.toMatchObject({ code: 'INSTALL_NOT_OWNED' });
    const installPlan = await orchestrator.plan(f.intent);
    await orchestrator.apply(installPlan, installPlan.confirmationDigest);
    const uninstallPlan = await orchestrator.planUninstall();
    await expect(orchestrator.uninstall('x')).rejects.toMatchObject({
      code: 'INSTALL_CONFIRMATION_MISMATCH',
    });
    await expect(orchestrator.uninstall(uninstallPlan.confirmationDigest)).resolves.toMatchObject({
      removed: true,
      releaseKey: f.manifest.releaseKey,
    });
    expect(adapter.values.size).toBe(0);
    expect(deactivated).toEqual([f.manifest.releaseKey]);
  });
});
