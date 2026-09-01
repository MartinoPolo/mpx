import { describe, expect, it, vi } from 'vitest';
import {
  cleanupPreparationWorker,
  pollPreparationTerminal,
  preparationDiagnostic,
  shouldRetryUnknownPreparation,
} from '../../src/node/preparation-worker-polling.js';

describe('preparation worker polling', () => {
  it.each(['ready', 'failed', 'cancelled', 'unknown'] as const)(
    'stops immediately on terminal %s',
    async (status) => {
      const load = vi.fn(async () => ({ status, steps: [] }));
      expect(
        await pollPreparationTerminal(load, { deadline: Date.now() + 1_000, intervalMs: 1 }),
      ).toMatchObject({ status });
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  it('retries only a first-attempt terminal unknown', () => {
    expect(shouldRetryUnknownPreparation(1, { status: 'unknown' })).toBe(true);
    for (const state of [
      null,
      undefined,
      {},
      { status: 'ready' },
      { status: 'failed' },
      { status: 'cancelled' },
      { status: 'preparing' },
      { status: 'cancelling' },
    ]) {
      expect(shouldRetryUnknownPreparation(1, state)).toBe(false);
    }
    expect(shouldRetryUnknownPreparation(2, { status: 'unknown' })).toBe(false);
  });

  it('invokes and fully awaits unknown cleanup before continuation', async () => {
    let resolveCancel!: () => void;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    let continued = false;
    const cleanup = cleanupPreparationWorker({ status: 'unknown' }, cancel).then(() => {
      continued = true;
    });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(continued).toBe(false);
    resolveCancel();
    await cleanup;
    expect(continued).toBe(true);
  });

  it.each(['preparing', 'cancelling'] as const)('cleans up active %s state', async (status) => {
    const cancel = vi.fn(async () => undefined);
    await cleanupPreparationWorker({ status }, cancel);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    undefined,
    {},
    { status: 'ready' },
    { status: 'failed' },
    { status: 'cancelled' },
  ])('does not clean up terminal or missing state %#', async (state) => {
    const cancel = vi.fn(async () => undefined);
    await cleanupPreparationWorker(state, cancel);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not continue to retry until unknown cleanup succeeds', async () => {
    const state = { status: 'unknown' } as const;
    let cleanupFails = true;
    const cancel = vi.fn(async () => {
      if (cleanupFails) {
        throw new Error('cleanup failed');
      }
    });
    const retry = vi.fn();
    const cleanupThenRetry = async () => {
      await cleanupPreparationWorker(state, cancel);
      retry();
    };

    await expect(cleanupThenRetry()).rejects.toThrow('cleanup failed');
    expect(retry).not.toHaveBeenCalled();

    cleanupFails = false;
    await cleanupThenRetry();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps diagnostics useful, sanitized, and hard bounded', () => {
    const oversized = 'x'.repeat(2_000);
    const diagnostic = preparationDiagnostic({
      status: `failed\u0000${oversized}`,
      steps: Array.from({ length: 20 }, (_, index) => ({
        id: `step\n${index}${oversized}`,
        status: `failed\t${oversized}`,
        logPath: index === 0 ? 'private-path' : undefined,
      })),
    });
    expect(diagnostic).toContain('status=failed ');
    expect(diagnostic).toContain('"id":"step 0');
    expect(diagnostic).toContain('"status":"failed ');
    expect(diagnostic).toContain('"hasLog":true');
    expect(diagnostic).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(diagnostic).not.toContain('private-path');
    expect(diagnostic).not.toContain('PATH=');
    expect(diagnostic.length).toBeLessThanOrEqual(1_024);
  });
});
