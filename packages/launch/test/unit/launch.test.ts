import { expect, it, vi } from 'vitest';
import type { ProjectConfig, UserConfig } from '@mpx/config';
import { createSkillArtifactReference, sha256Canonical } from '@mpx/core';
import {
  canonicalNativeRootDigest,
  parseLaunchDescriptor,
  resolveLaunch,
  resolveLaunchSelection,
  serializeLaunchPublic,
  validateLaunchDomain,
} from '../../src/index.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  realpath: async (value: string) => value.replaceAll('\\', '/'),
}));

const projectConfig: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'sample/app' },
  repository: { provider: 'github', remote: 'sample/app' },
  skills: { packs: ['development'] },
};
const userConfig: UserConfig = {
  schemaVersion: 2,
  identities: {
    personal: {
      domain: 'personal',
      runtimeRoots: { claude: 'C:/native/claude', pi: 'C:/native/pi' },
      gitAuthorRoute: 'git-personal',
      providerRoutes: { github: 'gh-personal' },
      allowedSkillPacks: ['development', 'personal'],
    },
    work: {
      domain: 'work',
      runtimeRoots: { claude: 'C:/native/work-claude', pi: 'C:/native/work-pi' },
      gitAuthorRoute: 'git-work',
      allowedSkillPacks: ['development'],
    },
  },
  domains: { personal: ['C:/projects'], work: ['C:/work'] },
  locations: {
    coding: { roots: ['C:/projects', 'C:/work'], skillPacks: ['development'] },
  },
  modes: {
    project: { resources: { 'selected-project': 'read-write' } },
    unrestricted: { resources: { host: 'read-write' } },
  },
  presets: {},
  launchDefaults: { locations: {}, projects: {} },
  networkPolicies: { implementation: { preset: 'balanced' } },
  executors: {},
};
const hash = (value: string) => value.repeat(64);
const selection = {
  location: { name: 'coding', canonicalRoot: 'C:/projects' },
  packs: ['development'] as const,
  source: 'project' as const,
};
const artifact = createSkillArtifactReference({
  runtime: 'pi',
  identity: 'personal',
  projectId: 'sample/app',
  repositoryId: 'sample/app',
  catalogHash: hash('a'),
  selection,
});
function rekey(value: Record<string, unknown>): Record<string, unknown> {
  const { launchKey: _launchKey, ...tuple } = value;
  return { ...tuple, launchKey: sha256Canonical(tuple as never) };
}

const base = {
  userConfig,
  projectConfig,
  projectId: 'sample/app',
  repositoryId: 'sample/app',
  cwd: 'C:/projects/repo',
  runtime: 'pi' as const,
  identity: 'personal',
  mode: 'project',
  skillArtifact: artifact,
  selectedNativeRuntimeRoot: 'C:/native/pi',
  policyInputs: { access: 1 },
};

it('binds bounded runtime arguments and recomputes the immutable descriptor key', async () => {
  const descriptor = await resolveLaunch({ ...base, runtimeArgs: ['--print', 'hello'] });
  expect(descriptor.runtimeArgs).toEqual(['--print', 'hello']);
  expect(parseLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);
  expect(() => parseLaunchDescriptor({ ...descriptor, launchKey: hash('f') })).toThrowError(
    expect.objectContaining({ code: 'LAUNCH_KEY_MISMATCH' }),
  );
  await expect(resolveLaunch({ ...base, runtimeArgs: ['bad\narg'] })).rejects.toMatchObject({
    code: 'RUNTIME_ARGS_INVALID',
  });
});

it('strictly validates and normalizes every descriptor field before trusting its key', async () => {
  const descriptor = await resolveLaunch(base);
  const malformed = [
    { ...descriptor, identity: { ...descriptor.identity, domain: 42 } },
    { ...descriptor, mode: false },
    { ...descriptor, workspace: 'container' },
    { ...descriptor, cwdClassification: { ...descriptor.cwdClassification, location: null } },
    { ...descriptor, executor: { ...descriptor.executor, isolation: 'virtual-machine' } },
    {
      ...descriptor,
      executor: {
        ...descriptor.executor,
        mounts: { ...descriptor.executor.mounts, policyEnforced: false },
      },
    },
    {
      ...descriptor,
      diagnostics: [
        {
          code: 'NOTICE',
          severity: 'error',
          status: 'projected',
          message: 'message',
          remediation: 'remediation',
        },
      ],
    },
    {
      ...descriptor,
      routes: { ...descriptor.routes, mcp: { allow: [], shareNativeAuth: true } },
    },
    {
      ...descriptor,
      intendedPolicy: { ...descriptor.intendedPolicy, mode: 'unrestricted' },
    },
    {
      ...descriptor,
      intendedPolicy: {
        ...descriptor.intendedPolicy,
        resources: { invented: 'read-write' },
      },
    },
    {
      ...descriptor,
      elevationAudit: {
        ...descriptor.elevationAudit,
        elevated: true,
        reason: null,
        banner: null,
      },
    },
    {
      ...descriptor,
      elevationAudit: { ...descriptor.elevationAudit, approvalsDigest: hash('f') },
    },
  ];

  expect(
    malformed.map((value) => {
      try {
        parseLaunchDescriptor(rekey(value as unknown as Record<string, unknown>));
        return 'accepted';
      } catch (error) {
        return (error as { code?: string }).code;
      }
    }),
  ).toEqual(malformed.map(() => 'LAUNCH_DESCRIPTOR_INVALID'));

  const mixedArtifact = createSkillArtifactReference({
    runtime: descriptor.runtime,
    identity: descriptor.identity.name,
    projectId: descriptor.binding.projectId,
    repositoryId: descriptor.binding.repositoryId,
    catalogHash: descriptor.skillArtifact.catalogHash,
    selection: { ...descriptor.selection, packs: ['personal', 'development'] },
  });
  const unsorted = {
    ...descriptor,
    selection: { ...descriptor.selection, packs: ['personal', 'development'] },
    skillArtifact: mixedArtifact,
  };
  expect(() => parseLaunchDescriptor(rekey(unsorted))).toThrowError(
    expect.objectContaining({ code: 'LAUNCH_KEY_MISMATCH' }),
  );
});

it('rejects recomputed descriptor keys when unknown fields are present', async () => {
  const descriptor = await resolveLaunch(base);
  expect(() => parseLaunchDescriptor(rekey({ ...descriptor, unknown: true }))).toThrowError(
    expect.objectContaining({ code: 'LAUNCH_DESCRIPTOR_UNKNOWN_FIELD' }),
  );
  expect(() =>
    parseLaunchDescriptor(
      rekey({
        ...descriptor,
        routes: { ...descriptor.routes, mcp: { ...descriptor.routes.mcp, unknown: true } },
      }),
    ),
  ).toThrowError(expect.objectContaining({ code: 'LAUNCH_DESCRIPTOR_UNKNOWN_FIELD' }));
});

it('requires explicit identity and never infers it from the CWD', async () => {
  const { identity: _identity, ...withoutIdentity } = base;
  await expect(resolveLaunchSelection(withoutIdentity)).rejects.toMatchObject({
    code: 'IDENTITY_REQUIRED',
  });
});

it('defaults only ordinary launches to project mode', async () => {
  const { mode: _mode, ...withoutMode } = base;
  await expect(resolveLaunchSelection(withoutMode)).resolves.toMatchObject({
    mode: { name: 'project' },
    provenance: { mode: 'built-in' },
  });
});

it('rejects native-root and artifact binding mismatches', async () => {
  await expect(
    resolveLaunch({ ...base, selectedNativeRuntimeRoot: 'C:/native/other' }),
  ).rejects.toMatchObject({
    code: 'NATIVE_RUNTIME_ROOT_MISMATCH',
  });
  const wrong = createSkillArtifactReference({
    runtime: 'pi',
    identity: 'personal',
    projectId: 'sample/app',
    repositoryId: 'other/repo',
    catalogHash: hash('a'),
    selection,
  });
  await expect(resolveLaunch({ ...base, skillArtifact: wrong })).rejects.toMatchObject({
    code: 'SKILL_ARTIFACT_REPOSITORY_MISMATCH',
  });
});

it('rejects cross-domain project launches without an explicit applicable resource', async () => {
  await expect(
    resolveLaunchSelection({ ...base, cwd: 'C:/work/repo' }).then(validateLaunchDomain),
  ).rejects.toMatchObject({ code: 'IDENTITY_DOMAIN_MISMATCH' });
});

it('rejects host selected by a preset unless the executor itself was explicit', async () => {
  const configured = structuredClone(userConfig);
  configured.presets.host = {
    identity: 'personal',
    mode: 'project',
    executor: 'host',
    workspace: 'direct',
    networkPolicy: 'implementation',
  };
  configured.launchDefaults.projects['sample/app'] = { personal: 'host' };
  const reason = 'Native tool';

  const request = {
    ...base,
    userConfig: configured,
    reason,
    hostApproval: { reason, approvalKey: hash('b') },
  };
  await expect(resolveLaunch(request)).rejects.toMatchObject({ code: 'HOST_EXPLICIT_REQUIRED' });
  await expect(resolveLaunch({ ...request, preset: 'host' })).rejects.toMatchObject({
    code: 'HOST_EXPLICIT_REQUIRED',
  });
});

it('requires exact host approval while retaining a clear non-isolation descriptor', async () => {
  const request = {
    ...base,
    executor: 'host' as const,
    workspace: 'direct' as const,
    reason: 'Native tool',
  };
  await expect(resolveLaunch(request)).rejects.toMatchObject({ code: 'HOST_APPROVAL_REQUIRED' });
  const descriptor = await resolveLaunch({
    ...request,
    hostApproval: { reason: request.reason, approvalKey: hash('b') },
  });
  expect(descriptor.executor).toMatchObject({
    name: 'host',
    effectiveEnforcement: 'advisory',
    isolation: 'none',
    confidentiality: { isolated: false },
  });
});

it('keeps policy input details private while binding their digest', async () => {
  const descriptor = await resolveLaunch({
    ...base,
    policyInputs: { prompt: 'private', token: 'secret', nativeRoot: 'C:/native/private' },
  });
  expect(descriptor.intendedPolicy.inputsDigest).toBe(
    sha256Canonical({ prompt: 'private', token: 'secret', nativeRoot: 'C:/native/private' }),
  );
  expect(JSON.stringify(serializeLaunchPublic(descriptor))).not.toContain('private');
});

it('rejects path-bearing or secret-like route labels', async () => {
  const unsafe = structuredClone(userConfig);
  unsafe.identities.personal!.gitAuthorRoute = 'C:/private/token';
  await expect(resolveLaunch({ ...base, userConfig: unsafe })).rejects.toMatchObject({
    code: 'ROUTE_LABEL_INVALID',
  });
  expect(canonicalNativeRootDigest('C:\\Native\\Pi\\')).toBe(
    canonicalNativeRootDigest('c:/native/pi'),
  );
});
