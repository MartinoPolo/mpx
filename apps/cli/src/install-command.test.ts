import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  InstallOrchestrator,
  MemoryTransactionStore,
  ProductionInstallerOperationAdapter,
  installerDigest,
  type CurrentReleaseBuilder,
  type InstallIntentBuildResultV1,
  type InstallIntentBuilder,
  type InstallIntentRequestV1,
  type InstallIntentV1,
  type InstallPlanV1,
  type ReleaseManifestV1,
} from '@mpx/installer';
import { FakeBinaryFileSystem, FakeJsonResourceStore } from '@mpx/windows';
import { executeInstallCommand } from './install-command.js';

const digest = 'a'.repeat(64);
const intent: InstallIntentV1 = {
  schemaVersion: 1,
  kind: 'install-intent',
  releaseKey: digest,
  convergenceHash: digest,
  components: ['cli'],
};
const planBase = {
  schemaVersion: 1 as const,
  kind: 'install-plan' as const,
  intent,
  observations: [],
  operations: [],
};
const plan: InstallPlanV1 = { ...planBase, confirmationDigest: installerDigest(planBase) };
async function jsonFile(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-cli-install-')),
    file = path.join(root, 'input.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}
const input = (action: string, options: [string, string | boolean][]) => ({
  action,
  args: [],
  options: new Map<string, string | boolean | string[]>(options),
});

it('reads an explicit intent and returns the stable read-only plan', async () => {
  const planMethod = vi.fn(async () => plan),
    orchestrator = { plan: planMethod } as unknown as InstallOrchestrator;
  const result = await executeInstallCommand(input('plan', [['intent', await jsonFile(intent)]]), {
    orchestrator,
  });
  expect(planMethod).toHaveBeenCalledWith(intent);
  expect(result.data).toEqual(plan);
});

it('routes inline request JSON to the intent builder', async () => {
  const request = { schemaVersion: 1, kind: 'install-intent-request' };
  const built: InstallIntentBuildResultV1 = {
    schemaVersion: 1,
    kind: 'install-intent-build-result',
    intent,
    externalPlans: [],
  };
  const build = vi.fn(async () => built),
    builder = { build } as unknown as InstallIntentBuilder;
  const orchestrator = {} as InstallOrchestrator;
  expect(
    (
      await executeInstallCommand(input('intent', [['request', JSON.stringify(request)]]), {
        orchestrator,
        builder,
      })
    ).data,
  ).toEqual(built);
  expect(build).toHaveBeenCalledWith(request);
});

it('routes intent and prepare actions to the builder and read-only planner', async () => {
  const request = {
    schemaVersion: 1,
    kind: 'install-intent-request',
  } as unknown as InstallIntentRequestV1;
  const built: InstallIntentBuildResultV1 = {
    schemaVersion: 1,
    kind: 'install-intent-build-result',
    intent,
    externalPlans: [],
  };
  const build = vi.fn(async () => built),
    builder = { build } as unknown as InstallIntentBuilder;
  const planMethod = vi.fn(async () => plan),
    orchestrator = { plan: planMethod } as unknown as InstallOrchestrator;
  const requestFile = await jsonFile(request);
  expect(
    (
      await executeInstallCommand(input('intent', [['request', requestFile]]), {
        orchestrator,
        builder,
      })
    ).data,
  ).toEqual(built);
  expect(
    (
      await executeInstallCommand(input('prepare', [['request', requestFile]]), {
        orchestrator,
        builder,
      })
    ).data,
  ).toEqual(plan);
  expect(build).toHaveBeenCalledTimes(2);
  expect(planMethod).toHaveBeenCalledExactlyOnceWith(intent);
});

it('routes a build-result envelope to install planning', async () => {
  const built: InstallIntentBuildResultV1 = {
    schemaVersion: 1,
    kind: 'install-intent-build-result',
    intent,
    externalPlans: [],
  };
  const planMethod = vi.fn(async () => plan),
    orchestrator = { plan: planMethod } as unknown as InstallOrchestrator;
  expect(
    (
      await executeInstallCommand(input('plan', [['intent', await jsonFile(built)]]), {
        orchestrator,
      })
    ).data,
  ).toEqual(plan);
  expect(planMethod).toHaveBeenCalledWith(intent);
});

it('applies only an explicit plan with its exact confirmation', async () => {
  const receipt = { schemaVersion: 1, kind: 'ownership-receipt' },
    apply = vi.fn(async () => receipt),
    orchestrator = { apply } as unknown as InstallOrchestrator;
  const result = await executeInstallCommand(
    input('apply', [
      ['plan', await jsonFile(plan)],
      ['confirm-plan', plan.confirmationDigest],
    ]),
    { orchestrator },
  );
  expect(apply).toHaveBeenCalledWith(plan, plan.confirmationDigest);
  expect(result.data).toEqual({ schemaVersion: 1, kind: 'install-apply', receipt });
});

it('forwards strict verification and returns the versioned verification', async () => {
  const verification = {
      schemaVersion: 1,
      kind: 'install-verification',
      releaseKey: digest,
      healthy: true,
      issues: [],
      checkedAt: '2025-01-01T00:00:00.000Z',
    },
    verify = vi.fn(async () => verification),
    orchestrator = { verify } as unknown as InstallOrchestrator;
  expect(
    (await executeInstallCommand(input('verify', [['strict', true]]), { orchestrator })).data,
  ).toEqual(verification);
  expect(verify).toHaveBeenCalledWith(true, undefined);
});

it('verifies a strict external plan through the standard read-only public boundary', async () => {
  const plan = {
    kind: 'raycast' as const,
    classification: 'manual-only' as const,
    automaticImport: false as const,
    encrypted: true as const,
    items: [],
    instructions: ['review'],
    confirmation: {
      required: true as const,
      scope: 'user-supplied-raycast-derivative',
      digest: installerDigest({ encrypted: true, items: [] }),
    },
    rollback: { automatic: false as const, steps: ['restore'] },
  };
  const planDigest = installerDigest(plan),
    verifierRef = `raycast:ray:${planDigest}`;
  const built: InstallIntentBuildResultV1 = {
    schemaVersion: 1,
    kind: 'install-intent-build-result',
    intent: {
      ...intent,
      externalIntegrations: [
        { id: 'ray', adapter: 'raycast', classification: 'manual-only', planDigest, verifierRef },
      ],
    },
    externalPlans: [
      {
        id: 'ray',
        adapter: 'raycast',
        classification: 'manual-only',
        planDigest,
        verifierRef,
        plan,
      },
    ],
  };
  const evidence = {
    schemaVersion: 1,
    kind: 'raycast-post-export-evidence',
    integrations: [{ id: 'ray', derivative: { encrypted: true, items: [] } }],
  };
  const externalResult = {
    schemaVersion: 1 as const,
    kind: 'install-external-verification' as const,
    integrations: [
      {
        id: 'ray',
        adapter: 'raycast' as const,
        planDigest,
        verifierRef,
        healthy: true,
        issues: [],
      },
    ],
  };
  const verifyExternal = vi.fn(async () => externalResult),
    builder = { verify: verifyExternal } as unknown as InstallIntentBuilder;
  const verification = {
    schemaVersion: 1,
    kind: 'install-verification',
    releaseKey: digest,
    healthy: true,
    issues: [],
    checkedAt: '2025-01-01T00:00:00.000Z',
  };
  const verify = vi.fn(async (_strict: boolean, source?: () => Promise<unknown>) => {
    expect(await source?.()).toEqual(externalResult);
    return verification;
  });
  const orchestrator = { verify } as unknown as InstallOrchestrator;
  const result = await executeInstallCommand(
    input('verify', [
      ['external-plan', await jsonFile(built)],
      ['raycast-post-export', await jsonFile(evidence)],
    ]),
    { orchestrator, builder },
  );
  expect(result.data).toEqual(verification);
  expect(verifyExternal).toHaveBeenCalledExactlyOnceWith(built, evidence);
  expect(verify).toHaveBeenCalledWith(false, expect.any(Function));
});

it('rejects post-export evidence without an external plan', async () => {
  await expect(
    executeInstallCommand(input('verify', [['raycast-post-export', await jsonFile({})]]), {
      orchestrator: {} as InstallOrchestrator,
    }),
  ).rejects.toMatchObject({ code: 'INSTALL_USAGE_ERROR' });
});

it('returns production-adapter scheduled-task run evidence through the public verify command', async () => {
  const releaseKey = 'b'.repeat(64),
    cliSha = 'c'.repeat(64);
  const manifest: ReleaseManifestV1 = {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey,
    convergenceHash: releaseKey,
    files: [{ path: 'bin/mpx.mjs', bytes: 3, sha256: cliSha }],
  };
  const releases: CurrentReleaseBuilder = {
    appsRoot: 'C:\\Apps',
    build: async () => manifest,
    publish: async () => manifest,
    verify: async () => [],
  };
  const inspect = vi.fn(async () => ({
    exists: true,
    state: 'Ready',
    lastRunAt: '2025-01-01T00:00:00.000Z',
    lastResult: 0,
  }));
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    {
      files: new FakeBinaryFileSystem(),
      resources: new FakeJsonResourceStore(),
      scheduledTaskStatus: { inspect },
    },
  );
  const orchestrator = new InstallOrchestrator({
    adapter,
    store: new MemoryTransactionStore(),
    releases,
    now: () => new Date('2024-12-31T23:59:00.000Z'),
  });
  const installIntent: InstallIntentV1 = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey,
    convergenceHash: releaseKey,
    components: ['cli'],
  };
  const installPlan = await orchestrator.plan(installIntent);
  await orchestrator.apply(installPlan, installPlan.confirmationDigest);
  expect(inspect).not.toHaveBeenCalled();
  expect((await executeInstallCommand(input('verify', []), { orchestrator })).data).toMatchObject({
    healthy: true,
    scheduledTask: { status: 'healthy', lastResult: 0, lastRunAt: '2025-01-01T00:00:00.000Z' },
  });
  expect(inspect).toHaveBeenCalledExactlyOnceWith('\\MPX\\Session Capture');
});

it('requires transaction identity and exact confirmation for rollback', async () => {
  const rollback = vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'install-rollback',
      transactionId: 'tx',
      rolledBack: true as const,
    })),
    orchestrator = { rollback } as unknown as InstallOrchestrator;
  await executeInstallCommand(
    input('rollback', [
      ['transaction', 'tx'],
      ['confirm-plan', digest],
    ]),
    { orchestrator },
  );
  expect(rollback).toHaveBeenCalledWith('tx', digest);
});

it('uninstalls owned state through a mandatory exact confirmation', async () => {
  const uninstall = vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'install-uninstall',
      releaseKey: digest,
      removed: true as const,
    })),
    orchestrator = { uninstall } as unknown as InstallOrchestrator;
  await executeInstallCommand(input('uninstall', [['confirm-plan', digest]]), { orchestrator });
  expect(uninstall).toHaveBeenCalledWith(digest);
});
