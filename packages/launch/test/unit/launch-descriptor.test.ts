import { describe, expect, it, vi } from 'vitest';
import type { ProjectConfig, UserConfig } from '@mpx/config';
import { createSkillArtifactReference, sha256Canonical } from '@mpx/core';
import type { JsonValue } from '@mpx/core';
import * as launch from '../../src/index.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  realpath: async (value: string) => value.replaceAll('\\', '/'),
}));

const digest = 'a'.repeat(64);
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
      allowedSkillPacks: ['development', 'personal'],
    },
  },
  domains: { personal: ['C:/projects'], external: ['C:/cloned', 'C:/control'] },
  locations: {
    coding: {
      roots: ['C:/projects', 'C:/cloned', 'C:/control'],
      skillPacks: ['development'],
    },
  },
  resourceRoots: {
    'cloned-repositories': ['C:/cloned'],
    'computer-control-config': ['C:/control'],
  },
  modes: {
    project: { resources: { 'selected-project': 'read-write' } },
    developer: {
      resources: {
        'cloned-repositories': 'read-only',
        'computer-control-config': 'read-only',
      },
    },
    unrestricted: { resources: { host: 'read-write' } },
  },
  presets: {},
  launchDefaults: { locations: {}, projects: {} },
  networkPolicies: { implementation: { preset: 'balanced' } },
  executors: {},
};
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
  catalogHash: digest,
  selection,
});

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
  policyInputs: { access: 'project' },
};

describe('launch descriptor contract', () => {
  it('creates and parses only schema v3 with one resolved skill selection', async () => {
    const descriptor = await launch.resolveLaunch(base);

    expect(descriptor).toMatchObject({ schemaVersion: 3, selection });
    expect(descriptor).not.toHaveProperty('skillPolicy');
    expect(descriptor).not.toHaveProperty('contentScope');
    expect(descriptor).not.toHaveProperty('grants');
    expect(descriptor).not.toHaveProperty('executorVerification');
    expect(launch.parseLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);
  });

  it('rejects a recomputed descriptor whose artifact binding differs from the launch', async () => {
    const descriptor = await launch.resolveLaunch(base);
    const mismatchedArtifact = createSkillArtifactReference({
      runtime: 'pi',
      identity: 'personal',
      projectId: 'sample/app',
      repositoryId: 'other/repo',
      catalogHash: digest,
      selection,
    });
    const { launchKey: _launchKey, ...tuple } = {
      ...descriptor,
      skillArtifact: mismatchedArtifact,
    };
    const rebound = { ...tuple, launchKey: sha256Canonical(tuple as unknown as JsonValue) };

    expect(() => launch.parseLaunchDescriptor(rebound)).toThrowError(
      expect.objectContaining({ code: 'SKILL_ARTIFACT_BINDING_MISMATCH' }),
    );
  });

  it('admits a cross-domain CWD only through an explicitly selected configured applicable resource', async () => {
    const controlArtifact = createSkillArtifactReference({
      runtime: 'pi',
      identity: 'personal',
      projectId: 'sample/app',
      repositoryId: 'sample/app',
      catalogHash: digest,
      selection: { ...selection, location: { name: 'coding', canonicalRoot: 'C:/control' } },
    });
    const descriptor = await launch.resolveLaunch({
      ...base,
      cwd: 'C:/control/repo',
      mode: 'developer',
      skillArtifact: controlArtifact,
    });

    expect(descriptor).toMatchObject({
      mode: 'developer',
      cwdClassification: { domain: 'external', applicableResource: 'computer-control-config' },
    });
    expect(launch.parseLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);

    const invalidResource = structuredClone(descriptor) as typeof descriptor & {
      cwdClassification: { applicableResource: string };
    };
    invalidResource.cwdClassification.applicableResource = 'unknown-resource';
    expect(() => launch.parseLaunchDescriptor(invalidResource)).toThrowError(
      expect.objectContaining({ code: 'LAUNCH_DESCRIPTOR_INVALID' }),
    );

    const { mode: _mode, ...withoutMode } = base;
    await expect(
      launch.resolveLaunch({ ...withoutMode, cwd: 'C:/cloned/repo' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_DOMAIN_MISMATCH' });
  });
});
