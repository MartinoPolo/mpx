import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RootAttestationService, RootAttestationStore } from '@mpx/sessions';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountApplicationService,
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

function fixture(overrides: Partial<AccountAttestationServicePort> = {}) {
  const attestation: AccountAttestationServicePort = {
    list: vi.fn(async () => []),
    verify: vi.fn(async () => record),
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

describe('AccountApplicationService native bindings', () => {
  it('resolves only exact verified Pi native bindings', async () => {
    const f = fixture();
    await expect(f.service.resolveNativeBinding(identity, 'pi', root)).resolves.toBe('ref-work');
    await expect(f.service.resolveNativeBinding(identity, 'claude', root)).resolves.toBeNull();
    expect(f.attestation.verify).toHaveBeenCalledOnce();
  });

  it('rejects duplicate, missing, and unconfigured native references', async () => {
    await expect(
      fixture({ list: vi.fn(async () => [record, { ...record }]) }).service.verifyNativeBinding(
        'ref-work',
      ),
    ).resolves.toBe('duplicate');
    await expect(fixture().service.verifyNativeBinding('missing')).resolves.toBe('unavailable');
    await expect(
      fixture({
        list: vi.fn(async () => [{ ...record, identity: { domain: 'other', name: 'other' } }]),
      }).service.verifyNativeBinding('ref-work'),
    ).resolves.toBe('mismatch');
  });

  it('verifies the configured root and live Pi auth for matching references', async () => {
    const f = fixture({ list: vi.fn(async () => [record]) });
    await expect(f.service.verifyNativeBinding('ref-work')).resolves.toBe('verified');
    expect(f.attestation.verify).toHaveBeenCalledWith(identity, root, 'ref-work');
    expect(f.auth.verify).toHaveBeenCalledWith(root);
  });

  it('keeps Node production composition bound to exact root attestation', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'mpx-application-account-'));
    const nativeRoot = path.join(temporary, 'pi-root');
    const stateRoot = path.join(temporary, 'state');
    await mkdir(nativeRoot);
    const auth = { verify: vi.fn(async () => undefined) };
    const attestation = new RootAttestationService(new RootAttestationStore(stateRoot), {
      createRef: () => 'ref-work',
    });
    await attestation.confirm(await attestation.plan('enroll', identity, nativeRoot));
    const service = createNodeAccountApplicationService({
      accounts: { work: { domain: 'work', runtimeRoots: { pi: nativeRoot } } },
      stateRoot,
      cwd: temporary,
      environment: {},
      rootAttestationService: attestation,
      accountAuthVerifier: auth,
      resolveTrustedExecutable: async () => ({ executable: 'unused', argvPrefix: [] }),
    });
    try {
      await expect(service.verifyNativeBinding('ref-work')).resolves.toBe('verified');
      expect(auth.verify).toHaveBeenCalledWith(nativeRoot);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
