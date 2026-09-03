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
  constructor(readonly automatic: readonly InstallOperationV1[]) {}
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
