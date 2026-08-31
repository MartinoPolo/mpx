import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RootAttestationService, RootAttestationStore } from '../../src/account-attestation.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-account-'));
  roots.push(root);
  const state = path.join(root, 'state'),
    personal = path.join(root, 'personal'),
    work = path.join(root, 'work');
  await Promise.all([mkdir(state), mkdir(personal), mkdir(work)]);
  let now = 0;
  const store = new RootAttestationStore(state);
  const service = new RootAttestationService(store, {
    now: () => new Date(++now).toISOString(),
    createRef: () => `ref-${now}`,
  });
  return { root, state, personal, work, store, service };
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
const identity = { domain: 'work', name: 'work' };

describe('root-attested Pi accounts', () => {
  it('does not write while creating an enrollment plan', async () => {
    const f = await fixture();
    const plan = await f.service.plan('enroll', identity, f.personal);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      operation: 'enroll',
      runtime: 'pi',
      identity,
      mode: 'root-attested',
    });
    await expect(readFile(f.store.registryFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(f.state, 'accounts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a stale confirmation after registry state changes', async () => {
    const f = await fixture();
    const stale = await f.service.plan('enroll', identity, f.personal);
    await f.service.confirm(
      await f.service.plan('enroll', { domain: 'personal', name: 'personal' }, f.work),
    );
    await expect(f.service.confirm(stale)).rejects.toMatchObject({ code: 'ACCOUNT_PLAN_STALE' });
  });

  it('enrolls and re-enrolls while preserving the opaque reference', async () => {
    const f = await fixture();
    const enrolled = await f.service.confirm(await f.service.plan('enroll', identity, f.personal));
    const reEnrolled = await f.service.confirm(await f.service.plan('re-enroll', identity, f.work));
    expect(reEnrolled.ref).toBe(enrolled.ref);
    expect(reEnrolled.rootDigest).not.toBe(enrolled.rootDigest);
  });

  it('rejects duplicate and concurrent claims on one root', async () => {
    const f = await fixture();
    await f.service.confirm(await f.service.plan('enroll', identity, f.personal));
    await expect(
      f.service.plan('enroll', { domain: 'personal', name: 'other' }, f.personal),
    ).rejects.toMatchObject({ code: 'ACCOUNT_ROOT_DUPLICATE' });
    const fresh = await fixture();
    const a = new RootAttestationService(new RootAttestationStore(fresh.state));
    const b = new RootAttestationService(new RootAttestationStore(fresh.state));
    const [pa, pb] = await Promise.all([
      a.plan('enroll', identity, fresh.personal),
      b.plan('enroll', { domain: 'personal', name: 'other' }, fresh.personal),
    ]);
    const results = await Promise.allSettled([a.confirm(pa), b.confirm(pb)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects missing and symlink roots', async () => {
    const f = await fixture();
    await expect(
      f.service.plan('enroll', identity, path.join(f.root, 'missing')),
    ).rejects.toMatchObject({ code: 'ACCOUNT_ROOT_INVALID' });
    const linked = path.join(f.root, 'linked');
    await symlink(f.personal, linked, 'junction');
    await expect(f.service.plan('enroll', identity, linked)).rejects.toMatchObject({
      code: 'ACCOUNT_ROOT_INVALID',
    });
  });

  it('reclaims only definitely-dead owners and never an aged live initializer', async () => {
    const f = await fixture(),
      lock = `${f.store.registryFile}.lock`,
      now = Date.now();
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: 40404, token: 'crashed' }),
    );
    const recovered = new RootAttestationStore(f.state, {
      now: () => now,
      lockWaitMs: 20,
      isPidAlive: (pid) => (pid === 40404 ? false : true),
    });
    await expect(
      new RootAttestationService(recovered).confirm(
        await new RootAttestationService(recovered).plan('enroll', identity, f.personal),
      ),
    ).resolves.toMatchObject({ identity });

    await mkdir(lock, { recursive: true });
    const liveToken = '11111111-1111-4111-8111-111111111111';
    await writeFile(
      path.join(lock, `initializer-${liveToken}.json`),
      JSON.stringify({ pid: 50505, token: liveToken }),
    );
    await utimes(lock, (now - 60_000) / 1000, (now - 60_000) / 1000);
    const blocked = new RootAttestationStore(f.state, {
      now: () => now,
      lockWaitMs: 0,
      staleInitializationMs: 10,
      isPidAlive: () => true,
    });
    await expect(
      blocked.transaction((registry) => ({ registry, result: true })),
    ).rejects.toMatchObject({ code: 'ACCOUNT_REGISTRY_LOCK_TIMEOUT' });
    await expect(stat(lock)).resolves.toBeDefined();
  });

  it('prevents a delayed initializer cleanup from removing its successor', async () => {
    const f = await fixture();
    let now = Date.now(),
      start!: () => void,
      resume!: () => void,
      successorStart!: () => void,
      successorResume!: () => void;
    const started = new Promise<void>((resolve) => {
        start = resolve;
      }),
      resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
    const successorStarted = new Promise<void>((resolve) => {
        successorStart = resolve;
      }),
      successorResumed = new Promise<void>((resolve) => {
        successorResume = resolve;
      });
    const first = new RootAttestationStore(f.state, {
      now: () => now,
      staleInitializationMs: 10,
      lockWaitMs: 2_000,
      processId: 101,
      afterLockInitializerCreated: async () => {
        start();
        await resumed;
      },
    });
    const delayed = first.transaction((registry) => ({ registry, result: 'first' }));
    await started;
    now += 1_000;
    const second = new RootAttestationStore(f.state, {
      now: () => now,
      staleInitializationMs: 10,
      lockWaitMs: 2_000,
      processId: 202,
      isPidAlive: (pid) => (pid === 101 ? false : true),
    });
    const succeeding = second.transaction(async (registry) => {
      successorStart();
      await successorResumed;
      return { registry, result: 'second' };
    });
    await successorStarted;
    resume();
    await expect(delayed).rejects.toMatchObject({ code: 'ACCOUNT_REGISTRY_LOCK_OWNERSHIP_LOST' });
    await expect(stat(`${f.store.registryFile}.lock`)).resolves.toBeDefined();
    successorResume();
    await expect(succeeding).resolves.toBe('second');
  });

  it('does not reclaim a lock when its owner file is transiently unavailable', async () => {
    const f = await fixture(),
      lock = `${f.store.registryFile}.lock`;
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 40404, token: 'live' }));
    const unavailable = Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    const store = new RootAttestationStore(f.state, {
      lockWaitMs: 0,
      readLockFile: async () => {
        throw unavailable;
      },
      isPidAlive: () => false,
    });
    await expect(store.transaction((registry) => ({ registry, result: true }))).rejects.toBe(
      unavailable,
    );
    await expect(stat(lock)).resolves.toBeDefined();
  });

  it('retries transient Windows release latency without failing the transaction', async () => {
    const f = await fixture();
    let attempts = 0;
    const store = new RootAttestationStore(f.state, {
      renameLock: async (source, target) => {
        if (
          source.endsWith('registry.json.lock') &&
          target.includes('.released-') &&
          attempts++ === 0
        ) {
          throw Object.assign(new Error('busy'), { code: 'EPERM' });
        }
        await rename(source, target);
      },
      releaseWait: async () => undefined,
    });
    await expect(store.transaction((registry) => ({ registry, result: 'saved' }))).resolves.toBe(
      'saved',
    );
    expect(attempts).toBe(2);
  });

  it('cleans up its own lock when initialization fails after owner creation', async () => {
    const f = await fixture(),
      failure = new Error('initializer failed');
    const store = new RootAttestationStore(f.state, {
      afterLockOwnerCreated: async () => {
        throw failure;
      },
    });
    await expect(store.transaction((registry) => ({ registry, result: true }))).rejects.toBe(
      failure,
    );
    await expect(stat(`${f.store.registryFile}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never removes a successor while retrying a transient release failure', async () => {
    const f = await fixture(),
      successor = { pid: 90909, token: 'successor' };
    let injected = false;
    const store = new RootAttestationStore(f.state, {
      renameLock: async (source, target) => {
        if (source.endsWith('registry.json.lock') && target.includes('.released-') && !injected) {
          injected = true;
          await rename(source, `${source}.old`);
          await mkdir(source);
          await writeFile(path.join(source, 'owner.json'), JSON.stringify(successor));
          throw Object.assign(new Error('busy'), { code: 'EPERM' });
        }
        await rename(source, target);
      },
      releaseWait: async () => undefined,
    });
    await expect(store.transaction((registry) => ({ registry, result: 'saved' }))).resolves.toBe(
      'saved',
    );
    await expect(
      readFile(path.join(`${f.store.registryFile}.lock`, 'owner.json'), 'utf8'),
    ).resolves.toBe(JSON.stringify(successor));
    await rm(`${f.store.registryFile}.lock.old`, { recursive: true, force: true });
  });

  it('recovers a safely aged malformed initializer', async () => {
    const f = await fixture(),
      now = Date.now(),
      lock = `${f.store.registryFile}.lock`;
    const malformed = path.join(lock, 'initializer-22222222-2222-4222-8222-222222222222.json');
    await mkdir(lock, { recursive: true });
    await writeFile(malformed, 'not-json');
    await utimes(lock, (now - 60_000) / 1000, (now - 60_000) / 1000);
    await utimes(malformed, (now - 60_000) / 1000, (now - 60_000) / 1000);
    const recovered = new RootAttestationStore(f.state, {
      now: () => now,
      lockWaitMs: 20,
      staleInitializationMs: 10,
    });
    await expect(recovered.transaction((registry) => ({ registry, result: true }))).resolves.toBe(
      true,
    );
  });

  it('rejects symlink registry files and parents', async () => {
    const fileCase = await fixture(),
      target = path.join(fileCase.root, 'registry-target.json');
    await writeFile(target, JSON.stringify({ schemaVersion: 1, records: [] }));
    await mkdir(path.dirname(fileCase.store.registryFile), { recursive: true });
    await symlink(target, fileCase.store.registryFile, 'file');
    await expect(fileCase.store.list()).rejects.toMatchObject({
      code: 'ACCOUNT_REGISTRY_MALFORMED',
    });
    const parentCase = await fixture(),
      external = path.join(parentCase.root, 'external-accounts');
    await mkdir(external);
    await symlink(external, path.join(parentCase.state, 'accounts'), 'junction');
    await expect(parentCase.store.list()).rejects.toMatchObject({
      code: 'ACCOUNT_REGISTRY_MALFORMED',
    });
  });

  it('rejects malformed state and secret-bearing fields', async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.store.registryFile), { recursive: true });
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(
        f.store.registryFile,
        JSON.stringify({
          schemaVersion: 1,
          records: [
            {
              schemaVersion: 1,
              ref: 'x',
              identity,
              runtime: 'pi',
              rootDigest: 'a'.repeat(64),
              mode: 'root-attested',
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              token: 'secret',
            },
          ],
        }),
      ),
    );
    await expect(f.store.list()).rejects.toMatchObject({ code: 'ACCOUNT_REGISTRY_MALFORMED' });
  });
});
