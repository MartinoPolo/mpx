import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ImmutableInstallerService,
  MemoryTransactionStore,
  NodeTransactionStore,
  installerDigest,
  type InstallIntent,
  type InstallOperation,
  type SideEffectAdapter,
  type StoredTransaction,
} from '../../src/transaction.js';

async function captureAggregateError(action: () => Promise<unknown>): Promise<AggregateError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AggregateError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected operation to reject with AggregateError');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  throw new Error('Expected aggregate entry to be an Error');
}

class BytesAdapter implements SideEffectAdapter {
  readonly name = 'files';
  constructor(
    readonly values: Map<string, Buffer>,
    readonly failAt = -1,
  ) {}
  calls = 0;
  restoreFailure: Error | undefined;
  async observe(operation: InstallOperation) {
    const value = this.values.get(operation.target);
    return value ? installerDigest(value.toString('base64')) : null;
  }
  async capture(operation: InstallOperation) {
    return this.values.get(operation.target)?.toString('base64') ?? null;
  }
  async apply(operation: InstallOperation) {
    if (this.calls++ === this.failAt) {
      throw new Error('injected');
    }
    if (operation.action === 'remove') {
      this.values.delete(operation.target);
    } else {
      this.values.set(operation.target, Buffer.from(operation.desiredDigest!));
    }
  }
  async restore(operation: InstallOperation, snapshot: string | null) {
    if (this.restoreFailure) {
      throw this.restoreFailure;
    }
    if (snapshot === null) {
      this.values.delete(operation.target);
    } else {
      this.values.set(operation.target, Buffer.from(snapshot, 'base64'));
    }
  }
  async receiptLocator(operation: InstallOperation) {
    return operation.id === '01-user-config'
      ? { kind: 'user-config', retention: 'user-owned' }
      : { kind: 'file' };
  }
  async hydrateReceiptOperation() {}
}
class RetainingAdapter implements SideEffectAdapter {
  readonly name = 'retaining';
  readonly values = new Map<string, string>();
  readonly hydrated = new Set<string>();
  requireHydrationBeforeObserve = false;
  async observe(operation: InstallOperation) {
    if (this.requireHydrationBeforeObserve && !this.hydrated.has(operation.id)) {
      throw Object.assign(new Error('operation was not hydrated'), { code: 'INSTALL_PLAN_STALE' });
    }
    return this.values.get(operation.target) ?? null;
  }
  async capture(operation: InstallOperation) {
    return this.values.get(operation.target) ?? null;
  }
  async apply(operation: InstallOperation) {
    if (operation.action === 'remove') {
      this.values.delete(operation.target);
    } else {
      this.values.set(operation.target, operation.desiredDigest!);
    }
  }
  async restore(operation: InstallOperation, snapshot: string | null) {
    if (snapshot === null) {
      this.values.delete(operation.target);
    } else {
      this.values.set(operation.target, snapshot);
    }
  }
  async receiptLocator(operation: InstallOperation) {
    return { kind: operation.id === 'config' ? 'user-owned' : 'installer-owned' };
  }
  async hydrateReceiptOperation(operation: InstallOperation, locator: unknown) {
    const kind = (locator as { kind?: unknown } | null)?.kind;
    if (
      operation.id === 'config'
        ? operation.target !== 'C:\\Roaming\\mpx\\config.json' || kind !== 'user-owned'
        : kind !== 'installer-owned'
    ) {
      throw Object.assign(new Error('forged'), { code: 'INSTALL_RECEIPT_FORGED' });
    }
    this.hydrated.add(operation.id);
  }
}
function operationLocators(operations: readonly InstallOperation[], spec: unknown = null) {
  return operations.map((operation) => ({
    operationId: operation.id,
    adapter: operation.adapter,
    spec,
    bindingDigest: installerDigest({ operation, spec }),
  }));
}

const intent: InstallIntent = {
  schemaVersion: 1,
  kind: 'install-intent',
  releaseKey: 'a'.repeat(64),
  convergenceHash: 'a'.repeat(64),
  components: ['cli'],
};

describe('durable installer transaction state', () => {
  it.each(['ensure', 'remove'] as const)(
    'skips capture and mutation state for unchanged %s after locked observation validation',
    async (action) => {
      const adapter = new RetainingAdapter();
      const store = new MemoryTransactionStore();
      const releaseKey = installerDigest([]);
      const operation: InstallOperation = {
        id: 'owned',
        adapter: adapter.name,
        action,
        target: 'owned',
        desiredDigest: action === 'ensure' ? 'b'.repeat(64) : null,
      };
      if (action === 'ensure') {
        adapter.values.set(operation.target, operation.desiredDigest!);
      }
      const service = new ImmutableInstallerService({
        adapters: [adapter],
        store,
        manifest: {
          schemaVersion: 1,
          kind: 'release-manifest',
          releaseKey,
          convergenceHash: releaseKey,
          files: [],
        },
      });
      const capture = vi.spyOn(adapter, 'capture');
      const apply = vi.spyOn(adapter, 'apply');
      const restore = vi.spyOn(adapter, 'restore');
      const plan = await service.plan({ ...intent, releaseKey, convergenceHash: releaseKey }, [
        operation,
      ]);
      await service.apply(plan, plan.confirmationDigest);
      const stored = (await store.readTransaction())!;
      expect(stored.operations).toEqual([operation]);
      expect(stored.operationLocators).toHaveLength(1);
      expect(stored.snapshots).toEqual({});
      expect(stored.journal.completedOperationIds).toEqual([]);
      expect(stored.journal.inFlightOperationId).toBeUndefined();
      await service.rollback();
      for (const spy of [capture, apply, restore]) {
        expect(spy).not.toHaveBeenCalled();
      }
      const drifted = new ImmutableInstallerService({
        adapters: [adapter],
        store,
        beforeApply: async () => {
          adapter.values.set(operation.target, 'c'.repeat(64));
        },
      });
      await expect(drifted.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({
        code: 'INSTALL_OBSERVATION_CHANGED',
      });
      expect(capture).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it('atomically persists private receipts and in-flight snapshots across process instances', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-installer-state-'));
    const store = new NodeTransactionStore(root);
    const releaseKey = installerDigest([]);
    const receipt = {
      schemaVersion: 2 as const,
      kind: 'ownership-receipt' as const,
      releaseKey,
      convergenceHash: releaseKey,
      files: [],
      operations: [],
      operationLocators: [],
      installedAt: '2025-01-01T00:00:00.000Z',
    };
    const snapshot = {
      schemaVersion: 1 as const,
      kind: 'machine-snapshot' as const,
      transactionId: 'tx',
      observations: [],
      capturedAt: '2025-01-01T00:00:00.000Z',
    };
    const stored = {
      journal: {
        schemaVersion: 1 as const,
        kind: 'transaction-journal' as const,
        transactionId: 'tx',
        phase: 'applying' as const,
        completedOperationIds: [],
        snapshot,
      },
      snapshots: {},
      operations: [],
      operationLocators: [],
    };
    await store.writeReceipt(receipt);
    await store.writeTransaction(stored);
    const restarted = new NodeTransactionStore(root);
    expect(await restarted.readReceipt()).toEqual(receipt);
    expect(await restarted.readTransaction()).toEqual(stored);
    if (process.platform !== 'win32') {
      expect((await stat(path.join(root, 'receipt.json'))).mode & 0o077).toBe(0);
    }
  });

  it('quarantines journals whose completed IDs are not the exact eligible prefix', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-invalid-prefix-'));
    await mkdir(root, { recursive: true });
    const operations: readonly InstallOperation[] = ['owned-a', 'owned-b', 'owned-c'].map(
      (target, index) => ({
        id: `op-${index}`,
        adapter: 'files',
        action: 'ensure',
        target,
        desiredDigest: String(index + 1).repeat(64),
      }),
    );
    const snapshot = {
      schemaVersion: 1,
      kind: 'machine-snapshot',
      transactionId: 'tx',
      observations: operations.map((operation) => ({ id: operation.id, digest: null })),
      capturedAt: '2025-01-01T00:00:00.000Z',
    };
    await writeFile(
      path.join(root, 'transaction.json'),
      JSON.stringify({
        journal: {
          schemaVersion: 1,
          kind: 'transaction-journal',
          transactionId: 'tx',
          phase: 'applying',
          completedOperationIds: ['op-1'],
          snapshot,
        },
        snapshots: { 'op-1': null },
        operations,
        operationLocators: operationLocators(operations),
      }),
    );
    const values = new Map([
      ['owned-a', Buffer.from('untouched-a')],
      ['owned-b', Buffer.from('mutated')],
      ['owned-c', Buffer.from('untouched-c')],
    ]);
    await expect(
      new ImmutableInstallerService({
        adapters: [new BytesAdapter(values)],
        store: new NodeTransactionStore(root),
      }).recover(),
    ).rejects.toMatchObject({ code: 'INSTALL_TRANSACTION_INVALID' });
    expect([...values.values()].map((value) => value.toString())).toEqual([
      'untouched-a',
      'mutated',
      'untouched-c',
    ]);
    expect(await readdir(root)).toEqual([expect.stringMatching(/^transaction\.corrupt\./u)]);
  });

  it('rejects an independently malformed snapshot map after valid operation IDs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-invalid-snapshots-'));
    await mkdir(root, { recursive: true });
    const operation: InstallOperation = {
      id: 'op',
      adapter: 'files',
      action: 'ensure',
      target: 'owned',
      desiredDigest: 'b'.repeat(64),
    };
    const snapshot = {
      schemaVersion: 1,
      kind: 'machine-snapshot',
      transactionId: 'tx',
      observations: [{ id: 'op', digest: null }],
      capturedAt: '2025-01-01T00:00:00.000Z',
    };
    await writeFile(
      path.join(root, 'transaction.json'),
      JSON.stringify({
        journal: {
          schemaVersion: 1,
          kind: 'transaction-journal',
          transactionId: 'tx',
          phase: 'applying',
          completedOperationIds: [],
          inFlightOperationId: 'op',
          snapshot,
        },
        snapshots: {},
        operations: [operation],
        operationLocators: operationLocators([operation]),
      }),
    );
    await expect(new NodeTransactionStore(root).readTransaction()).rejects.toMatchObject({
      code: 'INSTALL_TRANSACTION_INVALID',
    });
  });

  it('rejects missing, reordered, duplicate, forged, adapter-mismatched, and malformed locators', async () => {
    const operations: readonly InstallOperation[] = [
        {
          id: 'op-0',
          adapter: 'files',
          action: 'ensure',
          target: 'owned-a',
          desiredDigest: 'a'.repeat(64),
        },
        {
          id: 'op-1',
          adapter: 'files',
          action: 'ensure',
          target: 'owned-b',
          desiredDigest: 'b'.repeat(64),
        },
      ],
      locators = operationLocators(operations),
      snapshot = {
        schemaVersion: 1,
        kind: 'machine-snapshot',
        transactionId: 'tx',
        observations: operations.map((operation) => ({ id: operation.id, digest: null })),
        capturedAt: '2025-01-01T00:00:00.000Z',
      },
      base = {
        journal: {
          schemaVersion: 1,
          kind: 'transaction-journal',
          transactionId: 'tx',
          phase: 'applying',
          completedOperationIds: [],
          inFlightOperationId: 'op-0',
          snapshot,
        },
        snapshots: { 'op-0': null },
        operations,
        operationLocators: locators,
      },
      variants = [
        Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'operationLocators')),
        { ...base, operationLocators: locators.slice(1) },
        { ...base, operationLocators: [...locators].reverse() },
        { ...base, operationLocators: [locators[0], locators[0]] },
        {
          ...base,
          operationLocators: [{ ...locators[0], spec: { forged: true } }, locators[1]],
        },
        {
          ...base,
          operationLocators: [{ ...locators[0], adapter: 'forged' }, locators[1]],
        },
        {
          ...base,
          operationLocators: [{ ...locators[0], extra: true }, locators[1]],
        },
      ];
    for (const [index, transaction] of variants.entries()) {
      const root = await mkdtemp(path.join(tmpdir(), `mpx-invalid-locator-${index}-`));
      await writeFile(path.join(root, 'transaction.json'), JSON.stringify(transaction));
      await expect(new NodeTransactionStore(root).readTransaction()).rejects.toMatchObject({
        code: 'INSTALL_TRANSACTION_INVALID',
      });
    }
  });

  it('serializes transactions across independent store instances', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-installer-lock-'));
    const first = new NodeTransactionStore(root),
      second = new NodeTransactionStore(root);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const a = first.exclusive(async () => {
      events.push('first-enter');
      await held;
      events.push('first-exit');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = second.exclusive(async () => {
      events.push('second-enter');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['first-enter']);
    release();
    await Promise.all([a, b]);
    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });
});

describe('installer transactions', () => {
  it('hydrates durable receipt operations before verification after an adapter restart', async () => {
    const adapter = new RetainingAdapter(),
      store = new MemoryTransactionStore(),
      manifest = {
        schemaVersion: 1 as const,
        kind: 'release-manifest' as const,
        releaseKey: installerDigest([]),
        convergenceHash: installerDigest([]),
        files: [],
      },
      operation: InstallOperation = {
        id: 'native',
        adapter: adapter.name,
        action: 'ensure',
        target: 'C:\\native',
        desiredDigest: 'b'.repeat(64),
      };
    const installing = new ImmutableInstallerService({ adapters: [adapter], store, manifest });
    const plan = await installing.plan(
      {
        ...intent,
        releaseKey: manifest.releaseKey,
        convergenceHash: manifest.convergenceHash,
      },
      [operation],
    );
    await installing.apply(plan, plan.confirmationDigest);
    await installing.finalize();

    const restarted = new RetainingAdapter();
    restarted.values.set(operation.target, operation.desiredDigest!);
    restarted.requireHydrationBeforeObserve = true;
    await expect(
      new ImmutableInstallerService({ adapters: [restarted], store }).verify(),
    ).resolves.toMatchObject({ healthy: true, issues: [] });
    expect([...restarted.hydrated]).toEqual(['native']);
  });

  it('fails verification closed when a recomputed receipt locator is forged', async () => {
    const adapter = new RetainingAdapter(),
      store = new MemoryTransactionStore(),
      operation: InstallOperation = {
        id: 'config',
        adapter: adapter.name,
        action: 'ensure',
        target: 'C:\\Roaming\\arbitrary.json',
        desiredDigest: 'b'.repeat(64),
      },
      spec = { kind: 'user-owned' };
    adapter.values.set(operation.target, operation.desiredDigest!);
    await store.writeReceipt({
      schemaVersion: 2,
      kind: 'ownership-receipt',
      releaseKey: installerDigest([]),
      convergenceHash: installerDigest([]),
      files: [],
      operations: [operation],
      operationLocators: [
        {
          operationId: operation.id,
          adapter: operation.adapter,
          spec,
          bindingDigest: installerDigest({ operation, spec }),
        },
      ],
      installedAt: '2025-01-01T00:00:00.000Z',
    });

    await expect(
      new ImmutableInstallerService({ adapters: [adapter], store }).verify(),
    ).rejects.toMatchObject({ code: 'INSTALL_RECEIPT_FORGED' });
  });

  it('does not let a direct caller authorize an upgrade with a receipt hash argument', async () => {
    const store = new MemoryTransactionStore(),
      adapter = new RetainingAdapter(),
      operationA: InstallOperation = {
        id: 'shared',
        adapter: adapter.name,
        action: 'ensure',
        target: 'C:\\shared',
        desiredDigest: '1'.repeat(64),
      },
      releaseKeyA = installerDigest([]),
      intentA = { ...intent, releaseKey: releaseKeyA, convergenceHash: releaseKeyA },
      manifestA = {
        schemaVersion: 1 as const,
        kind: 'release-manifest' as const,
        releaseKey: releaseKeyA,
        convergenceHash: releaseKeyA,
        files: [],
      },
      serviceA = new ImmutableInstallerService({ adapters: [adapter], store, manifest: manifestA });
    const planA = await serviceA.plan(intentA, [operationA]);
    const receiptA = await serviceA.apply(planA, planA.confirmationDigest);
    await serviceA.finalize();
    const filesB = [{ path: 'next', bytes: 1, sha256: 'b'.repeat(64) }],
      releaseKeyB = installerDigest(filesB),
      intentB = { ...intent, releaseKey: releaseKeyB, convergenceHash: releaseKeyB },
      operationB = { ...operationA, desiredDigest: '2'.repeat(64) },
      serviceB = new ImmutableInstallerService({
        adapters: [adapter],
        store,
        manifest: {
          ...manifestA,
          releaseKey: releaseKeyB,
          convergenceHash: releaseKeyB,
          files: filesB,
        },
      }),
      planB = await serviceB.plan(intentB, [operationB], receiptA);

    await expect(
      (
        serviceB.apply as unknown as (
          planValue: typeof planB,
          confirmation: string,
          authority: string,
        ) => Promise<unknown>
      )(planB, planB.confirmationDigest, installerDigest(receiptA)),
    ).rejects.toMatchObject({ code: 'INSTALL_OWNERSHIP_MISMATCH' });
    expect(adapter.values.get(operationA.target)).toBe(operationA.desiredDigest);
  });

  it('revalidates observations and exact confirmation before side effects', async () => {
    const values = new Map([['config', Buffer.from('native')]]),
      adapter = new BytesAdapter(values),
      service = new ImmutableInstallerService({
        adapters: [adapter],
        store: new MemoryTransactionStore(),
        now: () => new Date('2025-01-01'),
      });
    const plan = await service.plan(intent, [
      {
        id: 'write',
        adapter: 'files',
        action: 'ensure',
        target: 'owned',
        desiredDigest: 'b'.repeat(64),
      },
    ]);
    values.set('owned', Buffer.from('foreign'));
    await expect(service.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({
      code: 'INSTALL_OBSERVATION_CHANGED',
    });
    expect(values.get('config')?.toString()).toBe('native');
  });

  it('rolls back every completed operation and preserves native state byte-for-byte on failure', async () => {
    for (let failure = 0; failure < 3; failure++) {
      const before = new Map([['native-config', Buffer.from([0, 1, 2, 255])]]),
        adapter = new BytesAdapter(before, failure),
        service = new ImmutableInstallerService({
          adapters: [adapter],
          store: new MemoryTransactionStore(),
          now: () => new Date('2025-01-01'),
        });
      const operations = ['owned-a', 'owned-b', 'owned-c'].map(
        (target, index): InstallOperation => ({
          id: `op-${index}`,
          adapter: 'files',
          action: 'ensure',
          target,
          desiredDigest: String(index + 1).repeat(64),
        }),
      );
      const plan = await service.plan(intent, operations);
      await expect(service.apply(plan, plan.confirmationDigest)).rejects.toThrow('injected');
      expect([...before.entries()].map(([key, value]) => [key, value.toString('hex')])).toEqual([
        ['native-config', '000102ff'],
      ]);
    }
  });

  it('restores completed and in-flight mutations without overwriting a never-run target', async () => {
    const values = new Map<string, Buffer>(),
      adapter = new BytesAdapter(values);
    adapter.apply = async (operation) => {
      adapter.calls += 1;
      if (operation.id === 'op-1') {
        values.set(operation.target, Buffer.from('partial'));
        values.set('owned-c', Buffer.from('external'));
        throw new Error('injected');
      }
      values.set(operation.target, Buffer.from(operation.desiredDigest!));
    };
    const service = new ImmutableInstallerService({
      adapters: [adapter],
      store: new MemoryTransactionStore(),
    });
    const operations = ['owned-a', 'owned-b', 'owned-c'].map((target, index): InstallOperation => ({
      id: `op-${index}`,
      adapter: 'files',
      action: 'ensure',
      target,
      desiredDigest: String(index + 1).repeat(64),
    }));
    const plan = await service.plan(intent, operations);
    await expect(service.apply(plan, plan.confirmationDigest)).rejects.toThrow('injected');
    expect(values.get('owned-a')).toBeUndefined();
    expect(values.get('owned-b')).toBeUndefined();
    expect(values.get('owned-c')?.toString()).toBe('external');
  });

  it('recovers disk-persisted completed and in-flight mutations through a fresh store instance', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-crash-recovery-'));
    const values = new Map([
        ['owned-a', Buffer.from('mutated')],
        ['owned-b', Buffer.from('partial')],
        ['owned-c', Buffer.from('external')],
      ]),
      adapter = new BytesAdapter(values);
    const operations = ['owned-a', 'owned-b', 'owned-c'].map((target, index): InstallOperation => ({
      id: `op-${index}`,
      adapter: 'files',
      action: 'ensure',
      target,
      desiredDigest: String(index + 1).repeat(64),
    }));
    const snapshot = {
      schemaVersion: 1 as const,
      kind: 'machine-snapshot' as const,
      transactionId: 'crashed',
      observations: operations.map((operation) => ({ id: operation.id, digest: null })),
      capturedAt: '2025-01-01T00:00:00.000Z',
    };
    const stored: StoredTransaction = {
      journal: {
        schemaVersion: 1,
        kind: 'transaction-journal',
        transactionId: 'crashed',
        phase: 'applying',
        completedOperationIds: ['op-0'],
        inFlightOperationId: 'op-1',
        snapshot,
      },
      snapshots: { 'op-0': null, 'op-1': null },
      operations,
      operationLocators: operationLocators(operations),
    };
    await new NodeTransactionStore(root).writeTransaction(stored);
    const restarted = new NodeTransactionStore(root);
    await new ImmutableInstallerService({ adapters: [adapter], store: restarted }).recover();
    expect(values.has('owned-a')).toBe(false);
    expect(values.has('owned-b')).toBe(false);
    expect(values.get('owned-c')?.toString()).toBe('external');
    expect((await restarted.readTransaction())?.journal).toMatchObject({ phase: 'rolled-back' });
    expect((await restarted.readTransaction())?.journal).not.toHaveProperty('inFlightOperationId');
  });

  it('adopts exact validated receipt-owned user config without overwriting it', async () => {
    const target = 'C:\\Roaming\\mpx\\config.json',
      edited = Buffer.from('{"identities":{},"domains":{}}'),
      values = new Map([[target, edited]]),
      adapter = new BytesAdapter(values),
      store = new MemoryTransactionStore(),
      prior: InstallOperation = {
        id: '01-user-config',
        adapter: 'files',
        action: 'ensure',
        target,
        desiredDigest: 'b'.repeat(64),
      },
      desiredDigest = installerDigest(edited.toString('base64')),
      desired = { ...prior, desiredDigest },
      spec = { kind: 'user-config', retention: 'user-owned' },
      releaseKey = installerDigest([]),
      validIntent = { ...intent, releaseKey, convergenceHash: releaseKey };
    await store.writeReceipt({
      schemaVersion: 2,
      kind: 'ownership-receipt',
      releaseKey,
      convergenceHash: releaseKey,
      files: [],
      operations: [prior],
      operationLocators: operationLocators([prior], spec),
      installedAt: '2025-01-01T00:00:00.000Z',
    });
    const service = new ImmutableInstallerService({
      adapters: [adapter],
      store,
      userConfigAdoption: {
        operationId: '01-user-config',
        adapter: 'files',
        target,
        desiredDigest,
        validatedArtifactDigest: desiredDigest,
      },
    });
    const apply = vi.spyOn(adapter, 'apply');
    const plan = await service.plan(validIntent, [desired], await store.readReceipt());
    const receipt = await service.apply(plan, plan.confirmationDigest);
    expect(values.get(target)).toEqual(edited);
    expect(apply).not.toHaveBeenCalled();
    expect(receipt.operations).toEqual([desired]);
    await service.rollback();
    expect(values.get(target)).toEqual(edited);
  });

  it.each([
    ['different path', { target: 'C:\\Elsewhere\\config.json' }],
    ['different adapter', { adapter: 'other' }],
    ['different kind', { spec: { kind: 'file' } }],
    ['different retention', { spec: { kind: 'user-config', retention: 'installer-owned' } }],
  ])('rejects user-config adoption with %s', async (_label, change) => {
    const target = 'C:\\Roaming\\mpx\\config.json',
      edited = Buffer.from('valid'),
      adapter = new BytesAdapter(new Map([[target, edited]])),
      store = new MemoryTransactionStore(),
      prior: InstallOperation = {
        id: '01-user-config',
        adapter: 'files',
        action: 'ensure',
        target,
        desiredDigest: 'b'.repeat(64),
      },
      digest = installerDigest(edited.toString('base64')),
      desired = {
        ...prior,
        target: 'target' in change ? change.target : target,
        adapter: 'adapter' in change ? change.adapter : 'files',
        desiredDigest: digest,
      },
      spec = 'spec' in change ? change.spec : { kind: 'user-config', retention: 'user-owned' };
    await store.writeReceipt({
      schemaVersion: 2,
      kind: 'ownership-receipt',
      releaseKey: installerDigest([]),
      convergenceHash: installerDigest([]),
      files: [],
      operations: [prior],
      operationLocators: operationLocators([prior], spec),
      installedAt: '2025-01-01T00:00:00.000Z',
    });
    const service = new ImmutableInstallerService({
      adapters: [adapter],
      store,
      userConfigAdoption: {
        operationId: '01-user-config',
        adapter: desired.adapter,
        target: desired.target,
        desiredDigest: digest,
        validatedArtifactDigest: digest,
      },
    });
    await expect(service.assertOwnedReceipt((await store.readReceipt())!)).rejects.toMatchObject({
      code: 'INSTALL_FOREIGN_OR_DRIFTED',
    });
  });

  it('rejects another drifted receipt resource while user config is adoptable', async () => {
    const configTarget = 'C:\\Roaming\\mpx\\config.json',
      edited = Buffer.from('valid'),
      adapter = new BytesAdapter(
        new Map([
          [configTarget, edited],
          ['other', Buffer.from('drift')],
        ]),
      ),
      store = new MemoryTransactionStore(),
      digest = installerDigest(edited.toString('base64')),
      config: InstallOperation = {
        id: '01-user-config',
        adapter: 'files',
        action: 'ensure',
        target: configTarget,
        desiredDigest: 'b'.repeat(64),
      },
      other: InstallOperation = {
        id: '20-other',
        adapter: 'files',
        action: 'ensure',
        target: 'other',
        desiredDigest: 'c'.repeat(64),
      };
    const configSpec = { kind: 'user-config', retention: 'user-owned' };
    await store.writeReceipt({
      schemaVersion: 2,
      kind: 'ownership-receipt',
      releaseKey: installerDigest([]),
      convergenceHash: installerDigest([]),
      files: [],
      operations: [config, other],
      operationLocators: [
        ...operationLocators([config], configSpec),
        ...operationLocators([other], { kind: 'file' }),
      ],
      installedAt: '2025-01-01T00:00:00.000Z',
    });
    const service = new ImmutableInstallerService({
      adapters: [adapter],
      store,
      userConfigAdoption: {
        operationId: '01-user-config',
        adapter: 'files',
        target: configTarget,
        desiredDigest: digest,
        validatedArtifactDigest: digest,
      },
    });
    await expect(service.assertOwnedReceipt((await store.readReceipt())!)).rejects.toMatchObject({
      code: 'INSTALL_FOREIGN_OR_DRIFTED',
    });
  });

  it('rejects a concurrent user-config edit after planning', async () => {
    const target = 'C:\\Roaming\\mpx\\config.json',
      edited = Buffer.from('valid'),
      values = new Map([[target, edited]]),
      adapter = new BytesAdapter(values),
      store = new MemoryTransactionStore(),
      digest = installerDigest(edited.toString('base64')),
      operation: InstallOperation = {
        id: '01-user-config',
        adapter: 'files',
        action: 'ensure',
        target,
        desiredDigest: digest,
      };
    const service = new ImmutableInstallerService({ adapters: [adapter], store });
    const plan = await service.plan(intent, [operation]);
    values.set(target, Buffer.from('concurrent'));
    await expect(service.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({
      code: 'INSTALL_OBSERVATION_CHANGED',
    });
    expect(values.get(target)?.toString()).toBe('concurrent');
  });

  it('retains apply transaction state and both failures when rollback fails', async () => {
    const values = new Map<string, Buffer>(),
      adapter = new BytesAdapter(values, 0),
      store = new MemoryTransactionStore(),
      service = new ImmutableInstallerService({ adapters: [adapter], store });
    adapter.restoreFailure = new Error('restore failed');
    const plan = await service.plan(intent, [
      {
        id: 'write',
        adapter: 'files',
        action: 'ensure',
        target: 'owned',
        desiredDigest: 'b'.repeat(64),
      },
    ]);
    const failure = await captureAggregateError(() => service.apply(plan, plan.confirmationDigest));
    expect(failure.message).toBe('injected');
    expect(failure.errors.map((error: unknown) => errorMessage(error))).toEqual([
      'injected',
      'restore failed',
    ]);
    expect(failure.cause).toBe(failure.errors[0]);
    expect((await store.readTransaction())?.journal).toMatchObject({
      phase: 'applying',
      inFlightOperationId: 'write',
    });
  });
});
