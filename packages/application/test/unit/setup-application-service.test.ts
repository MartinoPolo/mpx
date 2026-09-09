import { expect, it, vi } from 'vitest';
import { SetupApplicationService } from '../../src/setup-application-service.js';
import type {
  CurrentInstallationAdmission,
  InstallIntentBuildResult,
  InstallIntent,
  InstallPlan,
} from '@mpx/installer';

const digest = 'a'.repeat(64);
const intent = {
  schemaVersion: 1,
  kind: 'install-intent',
  releaseKey: digest,
  convergenceHash: digest,
  components: ['cli'],
} as InstallIntent;
const built = {
  schemaVersion: 1,
  kind: 'install-intent-build-result',
  intent,
} as InstallIntentBuildResult;
const plan = {
  schemaVersion: 1,
  kind: 'install-plan',
  intent,
  confirmationDigest: digest,
} as InstallPlan;

function fixture(status: CurrentInstallationAdmission['status'] = 'initial', failureAt?: string) {
  const order: string[] = [];
  const failure = new Error(`${failureAt} failed`);
  const record = (name: string) => {
    order.push(name);
    if (name === failureAt) {
      throw failure;
    }
  };
  const admission = { status, digest };
  const request = { kind: 'request' };
  const probe = { observe: vi.fn() };
  const dependencies = {
    requestFactory: {
      create: vi.fn(async () => {
        record('request');
        return request;
      }),
    },
    builder: {
      build: vi.fn(async (actual: unknown) => {
        expect(actual).toBe(request);
        record('build');
        return built;
      }),
    },
    installationProbe: probe,
    localReset: {
      run: vi.fn(async () => {
        record('reset');
      }),
    },
    detach: {
      run: vi.fn(async () => {
        record('detach');
      }),
    },
    legacyPiExtensionsCleanup: {
      run: vi.fn(async () => {
        record('cleanup');
      }),
    },
    orchestrator: {
      admitCurrentInstallation: vi.fn(async (actual, actualProbe) => {
        expect(actual).toBe(intent);
        expect(actualProbe).toBe(probe);
        record('admit');
        return admission;
      }),
      plan: vi.fn(async (actual, actualAdmission) => {
        expect(actual).toBe(intent);
        expect(actualAdmission).toBe(admission);
        record('plan');
        return plan;
      }),
      apply: vi.fn(async (actual, confirmation) => {
        expect(actual).toBe(plan);
        expect(confirmation).toBe(digest);
        record('apply');
        return {} as never;
      }),
      verify: vi.fn(async (strict) => {
        expect(strict).toBe(true);
        record('verify');
        return { healthy: true, issues: [] } as never;
      }),
    },
  } satisfies ConstructorParameters<typeof SetupApplicationService>[0];
  return { order, failure, dependencies, service: new SetupApplicationService(dependencies) };
}

it('admits before initial reset and exact legacy detach, then binds planning and strictly verifies', async () => {
  const value = fixture();
  await expect(value.service.execute()).resolves.toEqual({
    schemaVersion: 1,
    kind: 'setup-result',
    releaseKey: digest,
    verification: { healthy: true, issues: [] },
  });
  expect(value.order).toEqual([
    'request',
    'build',
    'admit',
    'reset',
    'detach',
    'cleanup',
    'plan',
    'apply',
    'verify',
  ]);
});

it('skips both reset and wholesale detachment for a verified current installation on each rerun', async () => {
  const value = fixture('current');
  await value.service.execute();
  await value.service.execute();
  expect(value.order).toEqual([
    'request',
    'build',
    'admit',
    'cleanup',
    'plan',
    'apply',
    'verify',
    'request',
    'build',
    'admit',
    'cleanup',
    'plan',
    'apply',
    'verify',
  ]);
  expect(value.dependencies.localReset.run).not.toHaveBeenCalled();
  expect(value.dependencies.detach.run).not.toHaveBeenCalled();
});

it.each(['request', 'build', 'admit', 'reset', 'detach', 'cleanup', 'plan', 'apply', 'verify'])(
  'fails closed at %s without invoking later operations',
  async (failureAt) => {
    const value = fixture('initial', failureAt);
    await expect(value.service.execute()).rejects.toBe(value.failure);
    const sequence = [
      'request',
      'build',
      'admit',
      'reset',
      'detach',
      'cleanup',
      'plan',
      'apply',
      'verify',
    ];
    expect(value.order).toEqual(sequence.slice(0, sequence.indexOf(failureAt) + 1));
  },
);

it('reports unhealthy strict verification as a typed failure, not success', async () => {
  const value = fixture();
  value.dependencies.orchestrator.verify.mockResolvedValue({
    healthy: false,
    issues: ['drift'],
  } as never);
  await expect(value.service.execute()).rejects.toMatchObject({
    code: 'SETUP_VERIFICATION_FAILED',
    details: { issues: ['drift'] },
    retryable: true,
  });
});
