import { expect, it, vi } from 'vitest';
import { emitProductionBundles } from '../../src/projection-bundles.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

it('starts every production bundle request together and emits their stable filenames in order', async () => {
  const requests = new Map([
    ['production-subagents.ts', deferred<string>()],
    ['production-runtime.ts', deferred<string>()],
    ['launch-private-client.ts', deferred<string>()],
  ]);
  const started: string[] = [];
  const emitted: Array<[string, string]> = [];

  const emission = emitProductionBundles(
    async (filename, content) => {
      emitted.push([filename, content]);
    },
    (entry) => {
      started.push(entry);
      return requests.get(entry)!.promise;
    },
  );

  expect(started).toEqual([
    'production-subagents.ts',
    'production-runtime.ts',
    'launch-private-client.ts',
  ]);
  requests.get('launch-private-client.ts')!.resolve('client');
  requests.get('production-runtime.ts')!.resolve('runtime');
  requests.get('production-subagents.ts')!.resolve('subagents');
  await emission;

  expect(emitted).toEqual([
    ['production-subagents.mjs', 'subagents'],
    ['production-runtime.mjs', 'runtime'],
    ['launch-private-client.mjs', 'client'],
  ]);
});

it('emits no production bundles when any bundle request fails', async () => {
  const failure = new Error('bundle failed');
  const emit = vi.fn(async () => undefined);
  const bundle = vi.fn((entry: string) =>
    entry === 'production-runtime.ts' ? Promise.reject(failure) : Promise.resolve(entry),
  );

  await expect(emitProductionBundles(emit, bundle)).rejects.toBe(failure);

  expect(bundle).toHaveBeenCalledTimes(3);
  expect(emit).not.toHaveBeenCalled();
});
