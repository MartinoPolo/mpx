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
    'detach',
    'plan',
    'apply',
    'verify',
    'builder.verify',
  ]);
});

it('does not detach when immutable intent construction fails', async () => {
  const detach = vi.fn();
  const failure = new Error('release build failed');
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
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
  expect(detach).not.toHaveBeenCalled();
});

it('does not plan or apply when legacy detachment fails', async () => {
  const planOperation = vi.fn();
  const apply = vi.fn();
  const failure = new Error('detach failed');
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
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

it('rejects a manual-only plan without applying it', async () => {
  const apply = vi.fn();
  const service = new SetupApplicationService({
    requestFactory: { create: async () => ({}) },
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
