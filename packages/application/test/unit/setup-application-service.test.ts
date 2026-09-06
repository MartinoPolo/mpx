import { expect, it, vi } from 'vitest';
import { SetupApplicationService } from '../../src/setup-application-service.js';
import type { InstallIntentBuildResultV1, InstallIntentV1, InstallPlanV1 } from '@mpx/installer';

const digest = 'a'.repeat(64);
const intent = {
  schemaVersion: 1,
  kind: 'install-intent',
  releaseKey: digest,
  convergenceHash: digest,
  components: ['cli'],
} as InstallIntentV1;
const built = {
  schemaVersion: 1,
  kind: 'install-intent-build-result',
  intent,
  externalPlans: [],
} as InstallIntentBuildResultV1;
const plan = {
  schemaVersion: 1,
  kind: 'install-plan',
  intent,
  confirmationDigest: digest,
  classifications: { automatic: [], confirmationRequired: [], manualOnly: [] },
} as unknown as InstallPlanV1;

it('builds before detach, then plans, applies exact digest, and strictly verifies exact build', async () => {
  const order: string[] = [];
  const request = { kind: 'request' };
  const verification = { healthy: true, issues: [], checkedAt: 'variable' };
  const service = new SetupApplicationService({
    requestFactory: {
      create: vi.fn(async () => {
        order.push('request');
        return request;
      }),
    },
    localReset: {
      run: vi.fn(async () => {
        order.push('reset');
      }),
    },
    detach: {
      run: vi.fn(async () => {
        order.push('detach');
      }),
    },
    builder: {
      build: vi.fn(async (actual) => {
        expect(actual).toBe(request);
        order.push('build');
        return built;
      }),
      verify: vi.fn(async (actual) => {
        expect(actual).toBe(built);
        order.push('builder.verify');
        return {
          schemaVersion: 1,
          kind: 'install-external-verification',
          integrations: [],
        } as const;
      }),
    },
    orchestrator: {
      plan: vi.fn(async (actual) => {
        expect(actual).toBe(intent);
        order.push('plan');
        return plan;
      }),
      apply: vi.fn(async (actual, confirmation) => {
        expect(actual).toBe(plan);
        expect(confirmation).toBe(digest);
        order.push('apply');
        return {} as never;
      }),
      verify: vi.fn(async (strict, external) => {
        expect(strict).toBe(true);
        order.push('verify');
        await external?.();
        return verification as never;
      }),
    },
  });

  await expect(service.execute()).resolves.toEqual({
    schemaVersion: 1,
    kind: 'setup-result',
    releaseKey: digest,
    verification: { healthy: true, issues: [] },
  });
  expect(order).toEqual([
    'request',
    'build',
    'reset',
    'detach',
    'plan',
    'apply',
    'verify',
    'builder.verify',
  ]);
});

it('throws a typed failure instead of reporting success when strict verification is unhealthy', async () => {
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
    localReset: { run: async () => undefined },
    detach: { run: async () => undefined },
    builder: {
      build: async () => built,
      verify: async () =>
        ({ schemaVersion: 1, kind: 'install-external-verification', integrations: [] }) as const,
    },
    orchestrator: {
      plan: async () => plan,
      apply: async () => ({}) as never,
      verify: async () => ({ healthy: false, issues: ['drift'] }) as never,
    },
  });

  await expect(service.execute()).rejects.toMatchObject({
    code: 'SETUP_VERIFICATION_FAILED',
    message: 'Setup verification failed.',
    details: { issues: ['drift'] },
    retryable: true,
    remediation: 'Retry mpx setup and inspect mpx doctor --json.',
  });
});

it('does not reset local state when setup request construction fails', async () => {
  const localReset = vi.fn();
  const failure = new Error('request failed');
  const service = new SetupApplicationService({
    requestFactory: {
      create: async () => {
        throw failure;
      },
    },
    localReset: { run: localReset },
    detach: { run: vi.fn() },
    builder: { build: vi.fn(), verify: vi.fn() },
    orchestrator: { plan: vi.fn(), apply: vi.fn(), verify: vi.fn() },
  });
  await expect(service.execute()).rejects.toBe(failure);
  expect(localReset).not.toHaveBeenCalled();
});

it('does not detach when immutable intent construction fails', async () => {
  const detach = vi.fn();
  const localReset = vi.fn();
  const failure = new Error('release build failed');
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
    localReset: { run: localReset },
    detach: { run: detach },
    builder: {
      build: async () => {
        throw failure;
      },
      verify: vi.fn(),
    },
    orchestrator: { plan: vi.fn(), apply: vi.fn(), verify: vi.fn() },
  });
  await expect(service.execute()).rejects.toBe(failure);
  expect(localReset).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
});

it('does not detach when obsolete local-state reset fails', async () => {
  const detach = vi.fn();
  const failure = new Error('reset failed');
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
    localReset: {
      run: async () => {
        throw failure;
      },
    },
    detach: { run: detach },
    builder: { build: async () => built, verify: vi.fn() },
    orchestrator: { plan: vi.fn(), apply: vi.fn(), verify: vi.fn() },
  });
  await expect(service.execute()).rejects.toBe(failure);
  expect(detach).not.toHaveBeenCalled();
});

it('does not plan or apply when legacy detachment fails', async () => {
  const planOperation = vi.fn();
  const apply = vi.fn();
  const failure = new Error('detach failed');
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
    localReset: { run: async () => undefined },
    detach: {
      run: async () => {
        throw failure;
      },
    },
    builder: { build: async () => built, verify: vi.fn() },
    orchestrator: { plan: planOperation, apply, verify: vi.fn() },
  });
  await expect(service.execute()).rejects.toBe(failure);
  expect(planOperation).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it('does not apply or verify when planning fails', async () => {
  const apply = vi.fn();
  const verify = vi.fn();
  const failure = new Error('plan failed');
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
    localReset: { run: async () => undefined },
    detach: { run: async () => undefined },
    builder: { build: async () => built, verify: vi.fn() },
    orchestrator: {
      plan: async () => {
        throw failure;
      },
      apply,
      verify,
    },
  });
  await expect(service.execute()).rejects.toBe(failure);
  expect(apply).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
});

it('does not verify when apply fails', async () => {
  const verify = vi.fn();
  const failure = new Error('apply failed');
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
    localReset: { run: async () => undefined },
    detach: { run: async () => undefined },
    builder: { build: async () => built, verify: vi.fn() },
    orchestrator: {
      plan: async () => plan,
      apply: async () => {
        throw failure;
      },
      verify,
    },
  });
  await expect(service.execute()).rejects.toBe(failure);
  expect(verify).not.toHaveBeenCalled();
});

it('propagates strict verify failure only after apply', async () => {
  const order: string[] = [];
  const failure = new Error('verify failed');
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
    localReset: { run: async () => undefined },
    detach: { run: async () => undefined },
    builder: { build: async () => built, verify: vi.fn() },
    orchestrator: {
      plan: async () => plan,
      apply: async () => {
        order.push('apply');
        return {} as never;
      },
      verify: async () => {
        order.push('verify');
        throw failure;
      },
    },
  });

  await expect(service.execute()).rejects.toBe(failure);
  expect(order).toEqual(['apply', 'verify']);
});

it('can execute twice through idempotent dependency ports', async () => {
  const create = vi.fn(async () => ({}));
  const build = vi.fn(async () => built);
  const detach = vi.fn(async () => undefined);
  const planOperation = vi.fn(async () => plan);
  const apply = vi.fn(async () => ({}) as never);
  const verify = vi.fn(async () => ({ healthy: true, issues: [] }) as never);
  const service = new SetupApplicationService({
    requestFactory: { create },
    localReset: { run: async () => undefined },
    detach: { run: detach },
    builder: {
      build,
      verify: async () =>
        ({ schemaVersion: 1, kind: 'install-external-verification', integrations: [] }) as const,
    },
    orchestrator: { plan: planOperation, apply, verify },
  });

  await service.execute();
  await service.execute();

  for (const operation of [create, build, detach, planOperation, apply, verify]) {
    expect(operation).toHaveBeenCalledTimes(2);
  }
});

it('rejects a manual-only plan without applying it', async () => {
  const apply = vi.fn();
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
    localReset: { run: async () => undefined },
    detach: { run: async () => undefined },
    builder: {
      build: async () => built,
      verify: async () =>
        ({ schemaVersion: 1, kind: 'install-external-verification', integrations: [] }) as const,
    },
    orchestrator: {
      plan: async () => ({
        ...plan,
        classifications: {
          automatic: [],
          confirmationRequired: [],
          manualOnly: [{ id: 'external', planDigest: digest, verifierRef: 'x' }],
        },
      }),
      apply,
      verify: vi.fn(),
    },
  });
  await expect(service.execute()).rejects.toMatchObject({ code: 'SETUP_MANUAL_ACTION_REQUIRED' });
  expect(apply).not.toHaveBeenCalled();
});
