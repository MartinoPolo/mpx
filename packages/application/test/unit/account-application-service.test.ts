import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RootAttestationService, RootAttestationStore } from '@mpx/sessions';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountApplicationService,
  type AccountAttestationPlan,
  type AccountAttestationRecord,
  type AccountAttestationServicePort,
} from '../../src/account-application-service.js';
import { createNodeAccountApplicationService } from '../../src/node/account-application-service.js';

const identity = { domain: 'work', name: 'work' };
const root = 'private-root';
const record: AccountAttestationRecord = {
  schemaVersion: 1,
  ref: 'ref-work',
  identity,
  runtime: 'pi',
  rootDigest: 'a'.repeat(64),
  mode: 'root-attested',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const plan: AccountAttestationPlan = {
  schemaVersion: 1,
  operation: 'enroll',
  identity,
  runtime: 'pi',
  rootDigest: 'a'.repeat(64),
  mode: 'root-attested',
  stateDigest: 'b'.repeat(64),
  confirmationDigest: 'digest',
};

function fixture(overrides: Partial<AccountAttestationServicePort> = {}) {
  const attestation: AccountAttestationServicePort = {
    list: vi.fn(async () => []),
    find: vi.fn(async () => undefined),
    verify: vi.fn(async () => record),
    plan: vi.fn(async () => plan),
    confirm: vi.fn(async () => record),
    ...overrides,
  };
  const auth = { verify: vi.fn(async () => undefined) };
  const service = new AccountApplicationService({
    accounts: { work: { domain: 'work', runtimeRoots: { pi: root } } },
    attestation,
    auth,
  });
  return { service, attestation, auth };
}

async function nodeFixture(configuredRootName = 'pi-root') {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mpx-application-account-'));
  const nativeRoot = path.join(temporary, configuredRootName);
  const stateRoot = path.join(temporary, 'state');
  await mkdir(nativeRoot);
  const auth = { verify: vi.fn(async () => undefined) };
  const store = new RootAttestationStore(stateRoot);
  const attestation = new RootAttestationService(store, { createRef: () => 'ref-work' });
  const service = createNodeAccountApplicationService({
    accounts: { work: { domain: 'work', runtimeRoots: { pi: nativeRoot } } },
    stateRoot,
    cwd: temporary,
    environment: {},
    rootAttestationService: attestation,
    accountAuthVerifier: auth,
    resolveTrustedExecutable: async () => ({ executable: 'unused', argvPrefix: [] }),
  });
  return { temporary, nativeRoot, stateRoot, auth, service, store, attestation };
}

function expectPublicOutputRedacted(output: unknown, ...roots: string[]): void {
  const serialized = JSON.stringify(output);
  expect(serialized).not.toMatch(/"(?:root|ref|rootDigest)":/u);
  for (const configuredRoot of roots) {
    expect(serialized).not.toContain(JSON.stringify(configuredRoot));
  }
}

describe('AccountApplicationService', () => {
  it('rejects list options before consulting configured identities', async () => {
    const f = fixture();
    await expect(
      f.service.execute({ action: 'list', identityName: 'unknown', confirmationDigest: 'x' }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_USAGE_INVALID',
      message: 'Account list accepts no identity or confirmation options.',
    });
    expect(f.attestation.list).not.toHaveBeenCalled();
  });

  it('resolves status identity before rejecting confirmation', async () => {
    const f = fixture();
    await expect(
      f.service.execute({ action: 'status', identityName: 'unknown', confirmationDigest: 'x' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_UNKNOWN', message: "Unknown identity 'unknown'." });
  });

  it('authenticates only an exact enrollment plan and re-plans before confirmation', async () => {
    const events: string[] = [];
    const f = fixture({
      plan: vi.fn(async () => {
        events.push('plan');
        return plan;
      }),
      confirm: vi.fn(async () => {
        events.push('confirm');
        return record;
      }),
    });
    f.auth.verify.mockImplementation(async () => {
      events.push('auth');
    });
    await expect(
      f.service.execute({ action: 'enroll', identityName: 'work', confirmationDigest: 'digest' }),
    ).resolves.toMatchObject({ status: 'enrolled' });
    expect(events).toEqual(['plan', 'auth', 'plan', 'confirm']);
  });

  it('plans enrollment through the real Node store without probing OAuth or writing the registry', async () => {
    const f = await nodeFixture();
    try {
      const planned = await f.service.execute({ action: 'enroll', identityName: 'work' });
      expect(planned).toMatchObject({ status: 'planned' });
      expect(f.auth.verify).not.toHaveBeenCalled();
      await expect(readFile(f.store.registryFile, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expectPublicOutputRedacted(planned, f.nativeRoot);
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it('rejects stale real-store confirmation without probing OAuth or changing the registry', async () => {
    const f = await nodeFixture();
    try {
      const otherRoot = path.join(f.temporary, 'other-root');
      await mkdir(otherRoot);
      const planned = await f.service.execute({ action: 'enroll', identityName: 'work' });
      await f.attestation.confirm(
        await f.attestation.plan('enroll', { domain: 'personal', name: 'personal' }, otherRoot),
      );
      const before = await readFile(f.store.registryFile, 'utf8');
      await expect(
        f.service.execute({
          action: 'enroll',
          identityName: 'work',
          confirmationDigest: String(planned.confirmationDigest),
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_PLAN_STALE' });
      expect(f.auth.verify).not.toHaveBeenCalled();
      await expect(readFile(f.store.registryFile, 'utf8')).resolves.toBe(before);
      await expect(f.store.list()).resolves.toHaveLength(1);
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it('writes the expected real-store enrollment only after valid authenticated confirmation', async () => {
    const f = await nodeFixture();
    try {
      const planned = await f.service.execute({ action: 'enroll', identityName: 'work' });
      const enrolled = await f.service.execute({
        action: 'enroll',
        identityName: 'work',
        confirmationDigest: String(planned.confirmationDigest),
      });
      expect(f.auth.verify).toHaveBeenCalledOnce();
      await expect(f.store.list()).resolves.toMatchObject([
        { ref: 'ref-work', identity, runtime: 'pi', mode: 'root-attested' },
      ]);
      expect(enrolled).toMatchObject({ status: 'enrolled' });
      expectPublicOutputRedacted(enrolled, f.nativeRoot);
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it('reports missing real-store accounts through list and status with privacy-safe output', async () => {
    const f = await nodeFixture();
    try {
      const listed = await f.service.execute({ action: 'list' });
      const status = await f.service.execute({ action: 'status', identityName: 'work' });
      expect(listed).toMatchObject({ accounts: [{ identity, status: 'missing' }] });
      expect(status).toMatchObject({ identity, status: 'missing' });
      expectPublicOutputRedacted(listed, f.nativeRoot);
      expectPublicOutputRedacted(status, f.nativeRoot);
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it('rejects real-store verification for a missing account without probing OAuth', async () => {
    const f = await nodeFixture();
    try {
      await expect(
        f.service.execute({ action: 'verify', identityName: 'work' }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_ENROLLMENT_MISSING' });
      expect(f.auth.verify).not.toHaveBeenCalled();
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it('lists, reports, and verifies a real-store enrollment without exposing private claims', async () => {
    const f = await nodeFixture();
    try {
      await f.attestation.confirm(await f.attestation.plan('enroll', identity, f.nativeRoot));
      const listed = await f.service.execute({ action: 'list' });
      const status = await f.service.execute({ action: 'status', identityName: 'work' });
      const verified = await f.service.execute({ action: 'verify', identityName: 'work' });
      expect(listed).toMatchObject({ accounts: [{ identity, status: 'enrolled' }] });
      expect(status).toMatchObject({ identity, status: 'enrolled' });
      expect(verified).toMatchObject({ identity, status: 'verified' });
      expect(f.auth.verify).toHaveBeenCalledOnce();
      for (const output of [listed, status, verified]) {
        expectPublicOutputRedacted(output, f.nativeRoot);
      }
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it('reports a real-store configured root change and rejects verification without disclosure', async () => {
    const f = await nodeFixture('new-root');
    try {
      const oldRoot = path.join(f.temporary, 'old-root');
      await mkdir(oldRoot);
      await f.attestation.confirm(await f.attestation.plan('enroll', identity, oldRoot));
      const listed = await f.service.execute({ action: 'list' });
      const status = await f.service.execute({ action: 'status', identityName: 'work' });
      expect(listed).toMatchObject({ accounts: [{ identity, status: 'root-changed' }] });
      expect(status).toMatchObject({ identity, status: 'root-changed' });
      await expect(
        f.service.execute({ action: 'verify', identityName: 'work' }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_ROOT_CHANGED' });
      expect(f.auth.verify).not.toHaveBeenCalled();
      expectPublicOutputRedacted(listed, f.nativeRoot, oldRoot);
      expectPublicOutputRedacted(status, f.nativeRoot, oldRoot);
    } finally {
      await rm(f.temporary, { recursive: true, force: true });
    }
  });

  it('resolves only Pi native bindings', async () => {
    const f = fixture();
    await expect(f.service.resolveNativeBinding(identity, 'pi', root)).resolves.toBe('ref-work');
    await expect(f.service.resolveNativeBinding(identity, 'claude', root)).resolves.toBeNull();
  });

  it('reports duplicate native binding references', async () => {
    const f = fixture({ list: vi.fn(async () => [record, { ...record }]) });
    await expect(f.service.verifyNativeBinding('ref-work')).resolves.toBe('duplicate');
  });

  it('reports native bindings for unconfigured identities as mismatches', async () => {
    const f = fixture({
      list: vi.fn(async () => [{ ...record, identity: { domain: 'other', name: 'other' } }]),
    });
    await expect(f.service.verifyNativeBinding('ref-work')).resolves.toBe('mismatch');
  });

  it('reports absent native binding references as unavailable', async () => {
    const f = fixture();
    await expect(f.service.verifyNativeBinding('missing')).resolves.toBe('unavailable');
  });

  it('verifies matching native bindings with live authentication', async () => {
    const f = fixture({ list: vi.fn(async () => [record]) });
    await expect(f.service.verifyNativeBinding('ref-work')).resolves.toBe('verified');
    expect(f.auth.verify).toHaveBeenCalledWith(root);
  });
});
