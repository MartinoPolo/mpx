import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type InstallIntentV1, type InstallOperationV1 } from '../../src/immutable-core.js';
import { MemoryTransactionStore, installerDigest } from '../../src/transaction.js';
import {
  InstallOrchestrator,
  NodeCurrentReleaseBuilder,
  type InstallerOperationAdapter,
} from '../../src/orchestration.js';
class FixtureAdapter implements InstallerOperationAdapter {
  readonly name = 'fixture';
  readonly values = new Map<string, string>();
  applyCalls: string[] = [];
  statusCalls: string[] = [];
  constructor(public automatic: readonly InstallOperationV1[]) {}
  async operations() {
    return { automatic: this.automatic };
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

  it('migrates a legacy v1 receipt through its confirmation-bound plan and apply flow', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      owned = operation('10-owned', 'owned-target'),
      adapter = new FixtureAdapter([owned]),
      orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    adapter.values.set(owned.target, owned.desiredDigest!);
    await f.builder.publish(f.intent.releaseKey);
    await store.writeLegacyReceiptForMigration({
      schemaVersion: 1,
      kind: 'ownership-receipt',
      releaseKey: f.manifest.releaseKey,
      convergenceHash: f.manifest.convergenceHash,
      files: f.manifest.files,
      operations: [owned],
      installedAt: '2025-01-01T00:00:00.000Z',
    });

    const plan = await orchestrator.plan(f.intent);
    expect(plan.classifications?.confirmationRequired).toContainEqual(
      expect.objectContaining({
        id: 'ownership-receipt-v1-migration',
        verifierRef: 'installer:ownership-receipt-v2',
      }),
    );
    const receipt = await orchestrator.apply(plan, plan.confirmationDigest);

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      releaseKey: f.intent.releaseKey,
      operations: [owned],
      installedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(await store.readLegacyReceiptForMigration()).toBeUndefined();
  });

  it('upgrades a healthy prior-owned shared target to the current immutable release', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      sharedA = operation('10-shared', 'shared-target'),
      adapter = new FixtureAdapter([sharedA]),
      orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const planA = await orchestrator.plan(f.intent);
    const receiptA = await orchestrator.apply(planA, planA.confirmationDigest);

    await writeFile(path.join(f.repositoryRoot, 'dist', 'mpx.js'), 'next-release');
    const manifestB = await f.builder.build();
    const intentB = {
      ...f.intent,
      releaseKey: manifestB.releaseKey,
      convergenceHash: manifestB.releaseKey,
    };
    adapter.automatic = [{ ...sharedA, desiredDigest: installerDigest('shared-b') }];

    const planB = await orchestrator.plan(intentB);
    expect(planB.classifications?.confirmationRequired).toContainEqual({
      id: 'ownership-release-upgrade',
      planDigest: installerDigest(receiptA),
      verifierRef: 'installer:ownership-release-upgrade',
    });
    const receiptB = await orchestrator.apply(planB, planB.confirmationDigest);

    expect(receiptB.releaseKey).toBe(manifestB.releaseKey);
    expect(receiptB.releaseKey).not.toBe(receiptA.releaseKey);
    expect(receiptB.operations).toEqual(adapter.automatic);
    expect(adapter.values.get('shared-target')).toBe(installerDigest('shared-b'));
  });

  it('fails upgrade planning before mutation when a shared target is not exact prior ownership', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      sharedA = operation('10-shared', 'shared-target'),
      adapter = new FixtureAdapter([sharedA]),
      orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const planA = await orchestrator.plan(f.intent);
    await orchestrator.apply(planA, planA.confirmationDigest);
    adapter.applyCalls = [];
    adapter.values.set('shared-target', installerDigest('third-party'));
    await writeFile(path.join(f.repositoryRoot, 'dist', 'mpx.js'), 'next-release');
    const manifestB = await f.builder.build();
    adapter.automatic = [{ ...sharedA, desiredDigest: installerDigest('shared-b') }];

    await expect(
      orchestrator.plan({
        ...f.intent,
        releaseKey: manifestB.releaseKey,
        convergenceHash: manifestB.releaseKey,
      }),
    ).rejects.toMatchObject({ code: 'INSTALL_FOREIGN_OR_DRIFTED' });
    expect(adapter.applyCalls).toEqual([]);
  });

  it('rejects removed or altered upgrade authority without mutating the target', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      sharedA = operation('10-shared', 'shared-target'),
      adapter = new FixtureAdapter([sharedA]),
      orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const planA = await orchestrator.plan(f.intent);
    await orchestrator.apply(planA, planA.confirmationDigest);
    await writeFile(path.join(f.repositoryRoot, 'dist', 'mpx.js'), 'next-release');
    const manifestB = await f.builder.build(),
      intentB = {
        ...f.intent,
        releaseKey: manifestB.releaseKey,
        convergenceHash: manifestB.releaseKey,
      };
    adapter.automatic = [{ ...sharedA, desiredDigest: installerDigest('shared-b') }];
    const planB = await orchestrator.plan(intentB),
      classifications = planB.classifications!,
      authority = classifications.confirmationRequired.find(
        (reference) => reference.id === 'ownership-release-upgrade',
      )!;
    const attempts = [
      {
        ...planB,
        classifications: {
          ...classifications,
          confirmationRequired: classifications.confirmationRequired.filter(
            (reference) => reference.id !== authority.id,
          ),
        },
      },
      {
        ...planB,
        classifications: {
          ...classifications,
          confirmationRequired: classifications.confirmationRequired.map((reference) =>
            reference.id === authority.id
              ? { ...reference, verifierRef: 'installer:altered' }
              : reference,
          ),
        },
      },
    ];

    for (const attempt of attempts) {
      const { confirmationDigest: _confirmationDigest, ...body } = attempt,
        rebound = { ...body, confirmationDigest: installerDigest(body) };
      adapter.applyCalls = [];
      await expect(orchestrator.apply(rebound, rebound.confirmationDigest)).rejects.toMatchObject({
        code: expect.stringMatching(/^INSTALL_(PLAN_STALE|OWNERSHIP_MISMATCH)$/u),
      });
      expect(adapter.applyCalls).toEqual([]);
      expect(adapter.values.get('shared-target')).toBe(sharedA.desiredDigest);
    }
  });

  it('does not mutate when an upgrade target drifts after planning', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      sharedA = operation('10-shared', 'shared-target'),
      adapter = new FixtureAdapter([sharedA]),
      orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const planA = await orchestrator.plan(f.intent);
    await orchestrator.apply(planA, planA.confirmationDigest);
    await writeFile(path.join(f.repositoryRoot, 'dist', 'mpx.js'), 'next-release');
    const manifestB = await f.builder.build();
    adapter.automatic = [{ ...sharedA, desiredDigest: installerDigest('shared-b') }];
    const planB = await orchestrator.plan({
      ...f.intent,
      releaseKey: manifestB.releaseKey,
      convergenceHash: manifestB.releaseKey,
    });
    adapter.values.set('shared-target', installerDigest('concurrent'));
    adapter.applyCalls = [];

    await expect(orchestrator.apply(planB, planB.confirmationDigest)).rejects.toMatchObject({
      code: 'INSTALL_FOREIGN_OR_DRIFTED',
    });
    expect(adapter.applyCalls).toEqual([]);
    expect(adapter.values.get('shared-target')).toBe(installerDigest('concurrent'));
  });

  it('rejects an upgrade that drops or moves a prior shared operation', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      retained = operation('10-retained', 'retained-target'),
      changed = operation('20-changed', 'shared-target'),
      adapter = new FixtureAdapter([retained, changed]),
      orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const planA = await orchestrator.plan(f.intent);
    await orchestrator.apply(planA, planA.confirmationDigest);
    await writeFile(path.join(f.repositoryRoot, 'dist', 'mpx.js'), 'next-release');
    const manifestB = await f.builder.build(),
      intentB = {
        ...f.intent,
        releaseKey: manifestB.releaseKey,
        convergenceHash: manifestB.releaseKey,
      };

    for (const operations of [
      [{ ...changed, desiredDigest: installerDigest('shared-b') }],
      [
        retained,
        { ...changed, target: 'moved-target', desiredDigest: installerDigest('shared-b') },
      ],
    ]) {
      adapter.automatic = operations;
      adapter.applyCalls = [];
      await expect(orchestrator.plan(intentB)).rejects.toMatchObject({
        code: 'INSTALL_OWNERSHIP_MISMATCH',
      });
      expect(adapter.applyCalls).toEqual([]);
    }
  });

  it('binds an upgrade plan to the exact prior v2 ownership receipt', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      sharedA = operation('10-shared', 'shared-target'),
      adapter = new FixtureAdapter([sharedA]),
      orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const planA = await orchestrator.plan(f.intent);
    await orchestrator.apply(planA, planA.confirmationDigest);
    await writeFile(path.join(f.repositoryRoot, 'dist', 'mpx.js'), 'next-release');
    const manifestB = await f.builder.build();
    adapter.automatic = [{ ...sharedA, desiredDigest: installerDigest('shared-b') }];
    const planB = await orchestrator.plan({
      ...f.intent,
      releaseKey: manifestB.releaseKey,
      convergenceHash: manifestB.releaseKey,
    });
    const receipt = (await store.readReceipt())!;
    await store.writeReceipt({ ...receipt, installedAt: '2026-01-01T00:00:00.000Z' });
    adapter.applyCalls = [];

    await expect(orchestrator.apply(planB, planB.confirmationDigest)).rejects.toMatchObject({
      code: 'INSTALL_PLAN_STALE',
    });
    expect(adapter.applyCalls).toEqual([]);
  });

  it('restores the prior receipt and bytes when upgrade activation fails', async () => {
    const f = await fixture(),
      store = new MemoryTransactionStore(),
      sharedA = operation('10-shared', 'shared-target'),
      adapter = new FixtureAdapter([sharedA]);
    let failActivation = false;
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases: f.builder,
      activate: async () => {
        if (failActivation) {
          throw new Error('upgrade activation failed');
        }
        return async () => {};
      },
    });
    const planA = await orchestrator.plan(f.intent);
    const receiptA = await orchestrator.apply(planA, planA.confirmationDigest);
    await writeFile(path.join(f.repositoryRoot, 'dist', 'mpx.js'), 'next-release');
    const manifestB = await f.builder.build();
    adapter.automatic = [{ ...sharedA, desiredDigest: installerDigest('shared-b') }];
    const planB = await orchestrator.plan({
      ...f.intent,
      releaseKey: manifestB.releaseKey,
      convergenceHash: manifestB.releaseKey,
    });
    failActivation = true;

    await expect(orchestrator.apply(planB, planB.confirmationDigest)).rejects.toThrow(
      'upgrade activation failed',
    );
    expect(await store.readReceipt()).toEqual(receiptA);
    expect(adapter.values.get('shared-target')).toBe(sharedA.desiredDigest);
    await expect(
      readFile(path.join(f.appsRoot, 'mpx', 'releases', receiptA.releaseKey, 'dist', 'mpx.js')),
    ).resolves.toBeTruthy();
    await expect(
      readFile(path.join(f.appsRoot, 'mpx', 'releases', manifestB.releaseKey, 'dist', 'mpx.js')),
    ).resolves.toBeTruthy();
  });

  it('activates the immutable release only after every apply side effect succeeds', async () => {
    const f = await fixture(),
      adapter = new FixtureAdapter([operation('10-automatic')]),
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
    expect(events).toEqual(['10-automatic', `active:${f.manifest.releaseKey}`]);
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
    let failure: unknown;
    try {
      await orchestrator.apply(plan, plan.confirmationDigest);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected installation to fail with an AggregateError.');
    }
    expect(failure.cause).toMatchObject({ code: 'INSTALL_POST_ACTIVATION_VERIFY_FAILED' });
    expect(
      Array.from(failure.errors, (error: unknown) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual([
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
});
