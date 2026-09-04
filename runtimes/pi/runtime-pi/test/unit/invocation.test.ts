import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRuntimeContextV1,
  createSessionLifecycleBindingV1,
  type PublishedRuntimeArtifactReference,
} from '@mpx/runtime-contracts';
import {
  createPiRuntimeProfileV1,
  planPiInvocation,
  verifyPiResumeTarget,
} from '../../src/index.js';

const invocationProfile = createPiRuntimeProfileV1(
  {
    schemaVersion: 1,
    runtime: 'pi',
    provider: 'openai-codex',
    defaultModel: 'openai-codex/gpt-5.6-sol',
    enabledModels: ['openai-codex/gpt-5.6-sol'],
  },
  [],
);

const runtimeContext = createRuntimeContextV1({
  launchKey: 'a'.repeat(64),
  launchDescriptor: { reference: 'launch.json', digest: 'b'.repeat(64) },
  manifestKey: 'c'.repeat(64),
  runtimeArtifact: {
    schemaVersion: 4,
    runtime: 'pi',
    manifestKey: 'c'.repeat(64),
    artifactKey: 'd'.repeat(64),
    fileMapHash: 'e'.repeat(64),
  },
  binding: { projectId: 'sample/app', repositoryId: 'sample/app', contentScope: 'work' },
});

it('creates a hermetic Pi invocation with launch-current-compatible runtime-context JSON', () => {
  const plan = planPiInvocation({
    executable: 'C:/trusted/pi.cmd',
    extension: 'C:/artifacts/pi-extension.js',
    profile: invocationProfile,
    accountRoot: 'C:/native/pi/account-a',
    immutableProjectionDirectory: 'C:/artifacts/pi',
    runtimeContextFile: 'C:/launch/context.json',
    runtimeContext,
    cwd: 'C:/repo',
  });
  expect(plan).toEqual({
    executable: 'C:/trusted/pi.cmd',
    cwd: 'C:/repo',
    args: [
      '--no-extensions',
      '--extension',
      'C:/artifacts/pi-extension.js',
      '--no-skills',
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.6-sol',
      '--thinking',
      'medium',
      '--tui-mode',
      'fullscreen',
      '--theme',
      'dark',
    ],
    env: {
      PI_CODING_AGENT_DIR: 'C:/native/pi/account-a',
      MPX_RUNTIME: 'pi',
      MPX_RUNTIME_CONTEXT: JSON.stringify(runtimeContext),
      MPX_RUNTIME_CONTEXT_FILE: 'C:/launch/context.json',
      MPX_ACTIVE_CONTENT_ROOT: 'C:/artifacts/pi',
      MPX_ACTIVE_CONTENT_MANIFEST: 'C:/artifacts/pi/active-content.json',
    },
  });
  const serializedRuntimeContext = plan.env.MPX_RUNTIME_CONTEXT;
  expect(serializedRuntimeContext).toBeDefined();
  if (!serializedRuntimeContext) {
    throw new Error('runtime context was not serialized');
  }
  expect(JSON.parse(serializedRuntimeContext)).toEqual(runtimeContext);
  expect(Object.keys(plan.env)).not.toEqual(
    expect.arrayContaining(['AUTH', 'SESSION', 'TRUST', 'CACHE']),
  );
  expect(plan.args).not.toEqual(
    expect.arrayContaining(['--auth', '--session', '--trust', '--cache']),
  );
});

it.each([
  ['personal', 'openai-codex', 'gpt-5.6-sol'],
  ['work', 'anthropic', 'claude-sonnet-4-6'],
] as const)(
  'pins the %s profile instead of consulting ambient native settings',
  (_identity, provider, model) => {
    const profile = createPiRuntimeProfileV1(
      {
        schemaVersion: 1,
        runtime: 'pi',
        provider,
        defaultModel: `${provider}/${model}`,
        enabledModels: [`${provider}/${model}`],
      },
      [],
    );
    const plan = planPiInvocation({
      executable: 'C:/trusted/pi.cmd',
      extension: 'C:/artifacts/pi-extension.js',
      profile,
      accountRoot: 'C:/native/pi/selected-account',
      runtimeContextFile: 'C:/launch/context.json',
      runtimeContext,
      cwd: 'C:/repo',
    });

    expect(plan.args.slice(3)).toEqual([
      '--no-skills',
      '--provider',
      provider,
      '--model',
      model,
      '--thinking',
      'medium',
      '--tui-mode',
      'fullscreen',
      '--theme',
      'dark',
    ]);
    expect(plan.env.PI_CODING_AGENT_DIR).toBe('C:/native/pi/selected-account');
  },
);

it('accepts only a module-verified regular Pi session beneath the exact account root', async () => {
  const account = await mkdtemp(path.join(tmpdir(), 'pi-resume-'));
  try {
    await mkdir(path.join(account, 'sessions'));
    await writeFile(path.join(account, 'sessions', 'session-a.jsonl'), 'session');
    const verified = await verifyPiResumeTarget(account, {
      kind: 'root-relative-file',
      value: 'sessions/session-a.jsonl',
    });
    const base = {
      executable: path.join(account, 'pi.cmd'),
      extension: path.join(account, 'extension.js'),
      profile: invocationProfile,
      accountRoot: account,
      runtimeContextFile: path.join(account, 'context.json'),
      runtimeContext,
      cwd: account,
    };
    expect(planPiInvocation({ ...base, resumeTarget: verified }).args.slice(-2)).toEqual([
      '--session',
      path.join(account, 'sessions', 'session-a.jsonl').replaceAll('\\', '/'),
    ]);
    expect(() => planPiInvocation({ ...base, resumeTarget: {} as typeof verified })).toThrow(
      /verified/u,
    );
    expect(() =>
      planPiInvocation({
        ...base,
        accountRoot: path.join(account, 'other'),
        resumeTarget: verified,
      }),
    ).toThrow(/account root/u);
  } finally {
    await rm(account, { recursive: true, force: true });
  }
});
it('rejects escaped, missing, and symlinked Pi resume targets during async verification', async () => {
  const account = await mkdtemp(path.join(tmpdir(), 'pi-resume-reject-')),
    outside = await mkdtemp(path.join(tmpdir(), 'pi-resume-outside-'));
  try {
    await mkdir(path.join(account, 'sessions'));
    await writeFile(path.join(outside, 'session'), 'session');
    await symlink(path.join(outside, 'session'), path.join(account, 'sessions', 'linked'), 'file');
    await expect(
      verifyPiResumeTarget(account, { kind: 'root-relative-file', value: '../escape' }),
    ).rejects.toThrow(/resume/u);
    await expect(
      verifyPiResumeTarget(account, { kind: 'root-relative-file', value: 'sessions/missing' }),
    ).rejects.toThrow(/resume/u);
    await expect(
      verifyPiResumeTarget(account, { kind: 'root-relative-file', value: 'sessions/linked' }),
    ).rejects.toThrow(/resume/u);
  } finally {
    await Promise.all([
      rm(account, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
it('injects only a full validated Pi lifecycle binding id and directory', () => {
  const binding = createSessionLifecycleBindingV1({
      bindingId: 'binding-1',
      bindingRef: 'ref',
      runtime: 'pi',
      identityRef: 'id',
      launchKey: runtimeContext.launchKey,
      launchDescriptorDigest: runtimeContext.launchDescriptor.digest,
      artifactKey: runtimeContext.runtimeArtifact.artifactKey,
      manifestKey: runtimeContext.manifestKey,
      projectRef: 'p',
      repositoryRef: 'r',
      worktreeRef: 'w',
      createdAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
    base = {
      executable: 'C:/trusted/pi.cmd',
      extension: 'C:/artifacts/pi-extension.js',
      profile: invocationProfile,
      accountRoot: 'C:/native/pi/account-a',
      runtimeContextFile: 'C:/launch/context.json',
      runtimeContext,
      cwd: 'C:/repo',
    };
  expect(
    planPiInvocation({ ...base, lifecycle: { eventDirectory: 'C:/events', binding } }).env,
  ).toMatchObject({
    MPX_SESSION_LIFECYCLE_BINDING_ID: 'binding-1',
    MPX_SESSION_LIFECYCLE_EVENT_DIR: 'C:/events',
  });
  expect(() =>
    planPiInvocation({
      ...base,
      lifecycle: { eventDirectory: 'C:/events', binding: { ...binding, manifestKey: 'wrong' } },
    }),
  ).toThrow(/BINDING_MISMATCH/u);
});
it('passes only the launch-private bridge attestation to the generated Pi extension', () => {
  const bridge = {
    schemaVersion: 1 as const,
    endpoint: 'tcp://127.0.0.1:43123',
    nonce: 'a'.repeat(64),
    launchKey: 'a'.repeat(64),
    identity: { name: 'work', domain: 'work' as const },
    planKey: 'c'.repeat(64),
    runtimeToolInventorySha256: 'd'.repeat(64),
    capabilitySha256: 'e'.repeat(64),
  };
  const plan = planPiInvocation({
    executable: 'C:/trusted/pi.cmd',
    extension: 'C:/artifacts/pi-extension.js',
    profile: invocationProfile,
    accountRoot: 'C:/native/pi/account-a',
    runtimeContextFile: 'C:/launch/context.json',
    runtimeContext,
    cwd: 'C:/repo',
    bridge,
  });
  const serializedBridge = plan.env.MPX_PI_LAUNCH_PRIVATE_BRIDGE;
  expect(serializedBridge).toBeDefined();
  if (!serializedBridge) {
    throw new Error('launch-private bridge was not serialized');
  }
  expect(JSON.parse(serializedBridge)).toEqual(bridge);
  expect(serializedBridge).not.toMatch(/oauth|auth\.json|accountRoot|token/iu);
});

it('binds the live status snapshot path only in the Pi child environment', () => {
  const plan = planPiInvocation({
    executable: 'C:/trusted/pi.cmd',
    extension: 'C:/artifacts/pi-extension.js',
    profile: invocationProfile,
    accountRoot: 'C:/native/pi/account-a',
    runtimeContextFile: 'C:/launch/context.json',
    runtimeContext,
    cwd: 'C:/repo',
    statusSnapshotPath: 'C:/private/status/current.json',
  });
  expect(plan.env.MPX_STATUS_SNAPSHOT_FILE).toBe('C:/private/status/current.json');
  expect(plan.args.join(' ')).not.toContain('current.json');
});

it('propagates the exact published projection reference as JSON', () => {
  const projectionReference: PublishedRuntimeArtifactReference = {
    projectionKey: 'f'.repeat(64),
    launchBinding: {
      launchKey: runtimeContext.launchKey,
      descriptorDigest: runtimeContext.launchDescriptor.digest,
      runtimeArtifactKey: runtimeContext.runtimeArtifact.artifactKey,
      runtime: 'pi',
      manifestKey: runtimeContext.manifestKey,
    },
    fileMapHash: 'e'.repeat(64),
  };
  const plan = planPiInvocation({
    executable: 'C:/trusted/pi.cmd',
    accountRoot: 'C:/native/pi/account-a',
    cwd: 'C:/repo',
    runtimeContext,
    projection: {
      directory: 'C:/artifacts/pi',
      extension: 'C:/artifacts/pi/extension.mjs',
      runtimeContextFile: 'C:/artifacts/pi/runtime-context.json',
      profile: invocationProfile,
      theme: 'dark',
      artifactKey: 'd'.repeat(64),
      reference: projectionReference,
      files: Object.freeze([]),
      reused: false,
      revalidation: {
        directory: 'C:/artifacts/pi',
        reference: projectionReference,
        profile: invocationProfile,
      },
    },
  });
  expect(plan.env.MPX_RUNTIME_PROJECTION_REFERENCE).toBe(JSON.stringify(projectionReference));
  expect(plan.env.MPX_ACTIVE_CONTENT_ROOT).toBe('C:/artifacts/pi');
  expect(plan.env.MPX_ACTIVE_CONTENT_MANIFEST).toBe('C:/artifacts/pi/active-content.json');
});
