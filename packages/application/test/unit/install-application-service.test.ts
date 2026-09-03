import { expect, it, vi } from 'vitest';
import {
  InstallApplicationService,
  type InstallProtocolInputPort,
} from '../../src/install-application-service.js';
import type {
  InstallIntentBuildResultV1,
  InstallIntentBuilder,
  InstallIntentV1,
  InstallOrchestrator,
  InstallPlanV1,
} from '@mpx/installer';

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
} as InstallPlanV1;

function inputs(overrides: Partial<InstallProtocolInputPort> = {}): InstallProtocolInputPort {
  return {
    request: vi.fn(async () => ({ kind: 'request' })),
    intent: vi.fn(async () => intent),
    plan: vi.fn(async () => plan),
    buildResult: vi.fn(async () => built),
    evidence: vi.fn(async () => ({})),
    ...overrides,
  };
}

it('loads an intent request before requiring the optional builder', async () => {
  const input = inputs();
  const service = new InstallApplicationService({ input, orchestrator: {} as InstallOrchestrator });
  await expect(
    service.execute({ action: 'intent', request: 'request.json' }),
  ).rejects.toMatchObject({
    code: 'INSTALL_USAGE_ERROR',
    message: 'install intent and prepare require an intent builder',
  });
  expect(input.request).toHaveBeenCalledWith('request.json');
});

it('builds prepare input before planning it', async () => {
  const events: string[] = [];
  const input = inputs({ request: vi.fn(async () => (events.push('read'), {})) });
  const builder = {
    build: vi.fn(async () => (events.push('build'), built)),
  } as unknown as InstallIntentBuilder;
  const orchestrator = {
    plan: vi.fn(async () => (events.push('plan'), plan)),
  } as unknown as InstallOrchestrator;
  const service = new InstallApplicationService({ input, orchestrator, builder: () => builder });
  await expect(service.execute({ action: 'prepare', request: 'request.json' })).resolves.toEqual(
    plan,
  );
  expect(events).toEqual(['read', 'build', 'plan']);
});

it('reads and discriminates plan input before invoking the planner', async () => {
  const read = vi.fn(async () => built);
  const planner = vi.fn(async () => plan);
  const service = new InstallApplicationService({
    input: inputs({ intent: read }),
    orchestrator: { plan: planner } as unknown as InstallOrchestrator,
  });
  await service.execute({ action: 'plan', intent: 'intent.json' });
  expect(read).toHaveBeenCalledWith('intent.json');
  expect(planner).toHaveBeenCalledWith(intent);
});

it('loads and parses apply plan before requiring confirmation and preserves the apply envelope', async () => {
  const input = inputs();
  const apply = vi.fn(async () => ({ kind: 'receipt' }));
  const service = new InstallApplicationService({
    input,
    orchestrator: { apply } as unknown as InstallOrchestrator,
  });
  await expect(service.execute({ action: 'apply', plan: 'plan.json' })).rejects.toMatchObject({
    message: '--confirm-plan is required',
  });
  expect(input.plan).toHaveBeenCalledWith('plan.json');
  await expect(
    service.execute({ action: 'apply', plan: 'plan.json', confirmation: digest }),
  ).resolves.toEqual({ schemaVersion: 1, kind: 'install-apply', receipt: { kind: 'receipt' } });
});

it('resolves retained external verification only inside the orchestrator callback', async () => {
  const events: string[] = [];
  const input = inputs({ buildResult: vi.fn(async () => (events.push('plan-read'), built)) });
  const verifyBuilder = vi.fn(async () => ({ kind: 'external' }));
  const getBuilder = vi.fn(() => {
    events.push('builder');
    return { verify: verifyBuilder } as unknown as InstallIntentBuilder;
  });
  const verify = vi.fn(async (_strict: boolean, source?: () => Promise<unknown>) => {
    events.push('orchestrator');
    await source?.();
    return { healthy: true };
  });
  const service = new InstallApplicationService({
    input,
    orchestrator: { verify } as unknown as InstallOrchestrator,
    builder: getBuilder,
  });
  await service.execute({ action: 'verify', externalPlan: 'plan.json', strict: true });
  expect(events).toEqual(['plan-read', 'orchestrator', 'builder']);
  expect(verifyBuilder).toHaveBeenCalledWith(built);
});

it('forwards strict verification without an external source', async () => {
  const verify = vi.fn(async () => ({ healthy: true }));
  const service = new InstallApplicationService({
    input: inputs(),
    orchestrator: { verify } as unknown as InstallOrchestrator,
  });
  await expect(service.execute({ action: 'verify', strict: true })).resolves.toEqual({
    healthy: true,
  });
  expect(verify).toHaveBeenCalledWith(true, undefined);
});

it('requires rollback transaction before confirmation', async () => {
  const service = new InstallApplicationService({
    input: inputs(),
    orchestrator: {} as InstallOrchestrator,
  });
  await expect(service.execute({ action: 'rollback' })).rejects.toMatchObject({
    message: '--transaction is required',
  });
});

it('forwards rollback identity and confirmation', async () => {
  const rollback = vi.fn(async () => ({ rolledBack: true }));
  const service = new InstallApplicationService({
    input: inputs(),
    orchestrator: { rollback } as unknown as InstallOrchestrator,
  });
  await service.execute({ action: 'rollback', transaction: 'tx', confirmation: digest });
  expect(rollback).toHaveBeenCalledWith('tx', digest);
});

it('forwards uninstall confirmation', async () => {
  const uninstall = vi.fn(async () => ({ removed: true }));
  const service = new InstallApplicationService({
    input: inputs(),
    orchestrator: { uninstall } as unknown as InstallOrchestrator,
  });
  await service.execute({ action: 'uninstall', confirmation: digest });
  expect(uninstall).toHaveBeenCalledWith(digest);
});
