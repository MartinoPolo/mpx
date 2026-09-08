import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { createSkillArtifactReference, type SkillArtifactFacts } from '@mpx/core';
import {
  parseGrant,
  parseLaunchDescriptorV2,
  resolveLaunch,
  resolveLaunchAlias,
  resolveLaunchSelection,
  serializeLaunchAudit,
  serializeLaunchPublic,
} from '../../src/index.js';
import type { ResolveLaunchInput } from '../../src/index.js';

const realpathFailures = new Map<string, string>();

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (value: string) => {
      const code = realpathFailures.get(value);
      if (code) {
        const error = new Error(code) as Error & { code?: string };
        error.code = code;
        throw error;
      }
      return value.replaceAll('\\', '/');
    },
  };
});

const config: UserConfig = {
  identities: {
    personal: {
      domain: 'personal',
      runtimeRoots: { claude: 'C:/native/claude', pi: 'C:/native/pi' },
      gitAuthorRoute: 'git-personal',
      providerRoutes: { github: 'gh-personal' },
      sshRoute: 'ssh-personal',
      mcpSharing: { allow: ['context7'], shareNativeAuth: false },
    },
    work: {
      domain: 'work',
      runtimeRoots: { claude: 'C:/native/work-claude', pi: 'C:/native/work-pi' },
      gitAuthorRoute: 'git-work',
    },
  },
  domains: {
    personal: ['C:/projects', 'C:/projects/team'],
    work: ['C:/work'],
    oss: ['C:/cloned'],
    'assistant-input': ['C:/assistant/input'],
    'assistant-output': ['C:/assistant/output'],
    'computer-control-config': ['C:/computer-control/config'],
    'computer-control-executable-settings': ['C:/computer-control/executables'],
  },
  contentScopes: {
    personal: { roots: ['C:/projects'], skillPacks: ['core', 'personal'] },
    team: { roots: ['C:/projects/team'], skillPacks: ['core'] },
    work: { roots: ['C:/work'], skillPacks: ['core', 'work'] },
    'cloned-repositories': { roots: ['C:/cloned'], skillPacks: ['core', 'work'] },
    'assistant-input': { roots: ['C:/assistant/input'], skillPacks: ['core', 'personal'] },
    'assistant-output': { roots: ['C:/assistant/output'], skillPacks: ['core', 'personal'] },
    'computer-control-config': { roots: ['C:/computer-control/config'], skillPacks: ['core'] },
    'computer-control-executable-settings': {
      roots: ['C:/computer-control/executables'],
      skillPacks: ['core'],
    },
  },
  modes: {
    project: { resources: { 'selected-project': 'read-write' } },
    developer: {
      resources: { 'identity-domain': 'read-write', 'cloned-repositories': 'read-only' },
    },
    'personal-assistant': {
      resources: { 'assistant-input': 'read-write', 'assistant-output': 'read-write' },
    },
    'computer-control': {
      resources: {
        'computer-control-config': 'read-write',
        'computer-control-executable-settings': 'staged-write',
      },
    },
    unrestricted: { resources: { host: 'read-write' } },
  },
  skillPolicies: {
    clean: { skillExposure: { default: 'explicit-only' } },
    developer: { skillExposure: { default: 'name-only' } },
  },
  presets: {
    personal: {
      identity: 'personal',
      mode: 'developer',
      skillPolicy: 'developer',
      contentScope: 'personal',
      executor: 'docker',
      workspace: 'clone',
      networkPolicy: 'implementation',
    },
    work: {
      identity: 'work',
      mode: 'project',
      skillPolicy: 'clean',
      contentScope: 'work',
      executor: 'docker',
      workspace: 'clone',
      networkPolicy: 'implementation',
    },
  },
  launchDefaults: {
    projects: { 'default/app': { personal: 'personal' } },
    scopes: { team: { personal: 'personal' }, work: { work: 'work' } },
  },
  networkPolicies: { implementation: { preset: 'balanced' }, minimal: { preset: 'deny-all' } },
  executors: {},
};

const hash = (digit: string) => digit.repeat(64);
const artifactFacts: SkillArtifactFacts = {
  runtime: 'pi',
  identity: 'personal',
  skillPolicy: 'clean',
  contentScope: 'personal',
  projectId: 'sample/app',
  catalogHash: hash('2'),
  enabledPacks: ['core', 'personal'],
  skillPolicyConfig: config.skillPolicies.clean as never,
  contentScopeExposure: {},
  projectExposure: null,
};
const artifact = (overrides: Partial<SkillArtifactFacts> = {}) =>
  createSkillArtifactReference({ ...artifactFacts, ...overrides });
const unboundBase = {
  userConfig: config,
  cwd: 'C:/projects/repo',
  runtime: 'pi',
  selectedNativeRuntimeRoot: 'C:/native/pi',
  policyInputs: { policyVersion: 1 },
} as const;
const base = {
  ...unboundBase,
  projectId: 'sample/app',
  skillArtifact: artifact(),
} as const;

afterEach(() => {
  realpathFailures.clear();
});

describe('launch resolution', () => {
  it('uses one exported canonical native-root digest', async () => {
    const { canonicalNativeRootDigest } = await import('../../src/index.js');
    expect(canonicalNativeRootDigest('C:\\Native\\Pi\\')).toBe(
      canonicalNativeRootDigest('c:/native/pi'),
    );
    expect(() => canonicalNativeRootDigest('relative/root')).toThrowError(/absolute/u);
  });
  it('creates and strictly parses schema v2 while recomputing its immutable launch key', async () => {
    const descriptor = await resolveLaunch({
      ...base,
      identity: 'personal',
      repositoryId: 'sample/repository',
      executorVerification: {
        status: 'verified',
        verifier: 'docker-probe',
        evidenceDigest: hash('e'),
      },
    });
    expect(descriptor).toMatchObject({
      schemaVersion: 2,
      binding: { projectId: 'sample/app', repositoryId: 'sample/repository' },
      executorVerification: { status: 'verified' },
    });
    expect(parseLaunchDescriptorV2(structuredClone(descriptor))).toEqual(descriptor);
    expect(() => parseLaunchDescriptorV2({ ...descriptor, launchKey: hash('f') })).toThrow(
      expect.objectContaining({ code: 'LAUNCH_KEY_MISMATCH' }),
    );
    expect(() =>
      parseLaunchDescriptorV2({ ...descriptor, privateRoute: 'C:/private/auth' }),
    ).toThrow(expect.objectContaining({ code: 'LAUNCH_DESCRIPTOR_UNKNOWN_FIELD' }));
    expect(Object.isFrozen(parseLaunchDescriptorV2(structuredClone(descriptor)))).toBe(true);
  });

  it('binds bounded runtime arguments to descriptor parsing and the launch key', async () => {
    const withoutArgs = await resolveLaunch({ ...base, identity: 'personal' });
    const runtimeArgs = ['--no-session', '--print', 'Reply with only: verified'];
    const withArgs = await resolveLaunch({ ...base, identity: 'personal', runtimeArgs });

    expect(withoutArgs).not.toHaveProperty('runtimeArgs');
    expect(withArgs.runtimeArgs).toEqual(runtimeArgs);
    expect(withArgs.launchKey).not.toBe(withoutArgs.launchKey);
    expect(parseLaunchDescriptorV2(structuredClone(withArgs))).toEqual(withArgs);
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        runtimeArgs: Array.from({ length: 65 }, () => 'arg'),
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_ARGS_INVALID' });
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        runtimeArgs: ['é'.repeat(8_193)],
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_ARGS_INVALID' });
    await expect(
      resolveLaunch({ ...base, identity: 'personal', runtimeArgs: ['unsafe\u0000arg'] }),
    ).rejects.toMatchObject({ code: 'RUNTIME_ARGS_INVALID' });
    expect(() => parseLaunchDescriptorV2({ ...withArgs, runtimeArgs: ['unsafe\narg'] })).toThrow(
      expect.objectContaining({ code: 'RUNTIME_ARGS_INVALID' }),
    );
    expect(() =>
      parseLaunchDescriptorV2({ ...withArgs, runtimeArgs: ['token=unredacted'] }),
    ).toThrow(expect.objectContaining({ code: 'LAUNCH_DESCRIPTOR_PRIVATE_DATA' }));
  });

  it('requires a runtime and rejects a skill artifact declared for another runtime', async () => {
    const { runtime: _runtime, ...withoutRuntime } = base;
    await expect(
      resolveLaunch({ ...withoutRuntime, identity: 'personal' } as ResolveLaunchInput),
    ).rejects.toMatchObject({ code: 'RUNTIME_REQUIRED' });
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        runtime: 'pi',
        skillArtifact: artifact({ runtime: 'claude' }),
      } as ResolveLaunchInput),
    ).rejects.toMatchObject({ code: 'SKILL_ARTIFACT_RUNTIME_MISMATCH' });
  });

  it('rejects skill artifacts without a valid recomputable safe tuple', async () => {
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        skillArtifact: { ...base.skillArtifact, artifactKey: 'artifact-1' },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_ARTIFACT_INVALID' });
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        skillArtifact: { ...base.skillArtifact, catalogHash: hash('5') },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_ARTIFACT_INVALID' });
  });

  it('rejects valid artifact references that mismatch resolved launch axes with stable codes', async () => {
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        skillArtifact: artifact({ identity: 'work' }),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_ARTIFACT_IDENTITY_MISMATCH' });
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        skillArtifact: artifact({
          skillPolicy: 'developer',
          skillPolicyConfig: config.skillPolicies.developer as never,
        }),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_ARTIFACT_POLICY_MISMATCH' });
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        skillArtifact: artifact({ contentScope: 'work' }),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_ARTIFACT_CONTENT_SCOPE_MISMATCH' });
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        skillArtifact: artifact({ projectId: 'acme/app' }),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_ARTIFACT_PROJECT_MISMATCH' });
  });

  it('binds a privacy-safe canonical selected native runtime root digest into launchKey', async () => {
    const first = await resolveLaunch({ ...base, identity: 'personal' });
    const changed = structuredClone(config);
    changed.identities.personal!.runtimeRoots.pi = 'C:/native/pi-other';
    const second = await resolveLaunch({
      ...base,
      userConfig: changed,
      identity: 'personal',
      selectedNativeRuntimeRoot: 'c:\\native\\pi-other',
    });
    expect(second.launchKey).not.toBe(first.launchKey);
    expect(second.nativeRuntimeRootDigest).not.toBe(first.nativeRuntimeRootDigest);
    expect(JSON.stringify(second)).not.toContain('pi-other');
  });

  it('requires identity explicitly or through an alias and never infers it from CWD/defaults', async () => {
    await expect(resolveLaunch(base)).rejects.toMatchObject({ code: 'IDENTITY_REQUIRED' });
  });

  it('resolves short aliases through known project and scope defaults without additional launch axes', async () => {
    const cases = [
      {
        alias: 'cc' as const,
        runtime: 'claude',
        identity: 'personal',
        cwd: 'C:/projects/repo',
        projectId: 'default/app',
        preset: 'personal',
        source: 'user-project',
      },
      {
        alias: 'pi' as const,
        runtime: 'pi',
        identity: 'personal',
        cwd: 'C:/projects/repo',
        projectId: 'default/app',
        preset: 'personal',
        source: 'user-project',
      },
      {
        alias: 'ccw' as const,
        runtime: 'claude',
        identity: 'work',
        cwd: 'C:/work/repo',
        projectId: 'work/app',
        preset: 'work',
        source: 'user-scope',
      },
      {
        alias: 'piw' as const,
        runtime: 'pi',
        identity: 'work',
        cwd: 'C:/work/repo',
        projectId: 'work/app',
        preset: 'work',
        source: 'user-scope',
      },
    ];
    for (const expected of cases) {
      const selection = await resolveLaunchSelection({
        userConfig: config,
        alias: expected.alias,
        cwd: expected.cwd,
        projectId: expected.projectId,
      });
      expect(selection).toMatchObject({
        runtime: expected.runtime,
        identity: { name: expected.identity },
        preset: expected.preset,
        provenance: {
          runtime: 'explicit',
          identity: 'explicit',
          mode: expected.source,
          skillPolicy: expected.source,
          contentScope: expected.source,
          executor: expected.source,
          workspace: expected.source,
          networkPolicy: expected.source,
        },
      });
    }
    expect(Object.keys(resolveLaunchAlias('cc'))).toEqual(['runtime', 'identity']);
    await expect(
      resolveLaunchSelection({
        userConfig: config,
        alias: 'cc',
        runtime: 'pi',
        cwd: 'C:/projects/repo',
      }),
    ).rejects.toMatchObject({ code: 'ALIAS_RUNTIME_MISMATCH' });
  });

  it('preserves preset identity while direct per-axis flags override its other axes', async () => {
    const descriptor = await resolveLaunch({
      ...base,
      identity: 'personal',
      preset: 'personal',
      mode: 'project',
      skillPolicy: 'clean',
    });
    expect(descriptor).toMatchObject({
      identity: { name: 'personal' },
      mode: 'project',
      skillPolicy: 'clean',
      contentScope: { name: 'personal' },
      executor: { name: 'docker' },
      preset: 'personal',
    });
    await expect(
      resolveLaunch({ ...base, identity: 'work', preset: 'personal' }),
    ).rejects.toMatchObject({ code: 'PRESET_IDENTITY_MISMATCH' });
  });

  it('selects project defaults before longest-root scope defaults before safe built-ins and reports safe provenance', async () => {
    const projectDefault = await resolveLaunchSelection({
      ...base,
      projectId: 'default/app',
      identity: 'personal',
    });
    expect(projectDefault).toMatchObject({
      preset: 'personal',
      provenance: { mode: 'user-project', workspace: 'user-project' },
    });
    const explicit = await resolveLaunchSelection({
      ...base,
      projectId: 'default/app',
      identity: 'personal',
      mode: 'project',
      skillPolicy: 'clean',
      contentScope: 'team',
      executor: 'host',
      workspace: 'direct',
      networkPolicy: 'minimal',
    });
    expect(explicit).toMatchObject({
      preset: 'personal',
      mode: { name: 'project' },
      skillPolicy: { name: 'clean' },
      contentScope: { name: 'team' },
      executor: 'host',
      workspace: 'direct',
      networkPolicy: { name: 'minimal' },
      provenance: {
        mode: 'explicit',
        skillPolicy: 'explicit',
        contentScope: 'explicit',
        executor: 'explicit',
        workspace: 'explicit',
        networkPolicy: 'explicit',
      },
    });
    const scopeDefault = await resolveLaunchSelection({
      ...base,
      projectId: 'other/app',
      cwd: 'C:/projects/team/repo',
      identity: 'personal',
    });
    expect(scopeDefault).toMatchObject({ preset: 'personal', provenance: { mode: 'user-scope' } });
    const builtInConfig = structuredClone(config);
    builtInConfig.launchDefaults = { projects: {}, scopes: {} };
    const builtIn = await resolveLaunchSelection({
      ...base,
      userConfig: builtInConfig,
      projectId: 'other/app',
      identity: 'personal',
    });
    expect(builtIn).toMatchObject({
      mode: { name: 'project' },
      skillPolicy: { name: 'clean' },
      contentScope: { name: 'personal' },
      executor: 'docker',
      workspace: 'clone',
      networkPolicy: { name: 'implementation' },
      provenance: {
        mode: 'built-in',
        skillPolicy: 'built-in',
        contentScope: 'built-in',
        executor: 'built-in',
        workspace: 'built-in',
        networkPolicy: 'built-in',
      },
    });
    expect(JSON.stringify(builtIn.provenance)).not.toContain('C:/');
  });

  it('uses canonical longest-root domain/content classification and distinguishes unknown from filesystem failures', async () => {
    const nested = await resolveLaunch({
      ...base,
      cwd: 'c:/PROJECTS/team/repo',
      identity: 'personal',
      skillPolicy: 'clean',
      contentScope: 'team',
      skillArtifact: artifact({ contentScope: 'team', enabledPacks: ['core'] }),
    });
    expect(nested.cwdClassification).toEqual({ domain: 'personal', contentScope: 'team' });
    await expect(
      resolveLaunch({ ...base, cwd: 'C:/elsewhere', identity: 'personal' }),
    ).rejects.toMatchObject({ code: 'CWD_CLASSIFICATION_UNKNOWN' });

    realpathFailures.set('C:/projects/repo', 'EACCES');
    await expect(resolveLaunch({ ...base, identity: 'personal' })).rejects.toMatchObject({
      code: 'CWD_CLASSIFICATION_FAILED',
      details: { errno: 'EACCES' },
    });
  });

  it('derives omitted mode defaults from the classified CWD domain only and fails when an inferred mode is unavailable', async () => {
    await expect(
      resolveLaunchSelection({ ...base, identity: 'personal', cwd: 'C:/assistant/input/note' }),
    ).resolves.toMatchObject({ mode: { name: 'personal-assistant' } });
    await expect(
      resolveLaunchSelection({ ...base, identity: 'personal', cwd: 'C:/assistant/output/note' }),
    ).resolves.toMatchObject({ mode: { name: 'personal-assistant' } });
    await expect(
      resolveLaunchSelection({ ...base, identity: 'personal', cwd: 'C:/computer-control/config' }),
    ).resolves.toMatchObject({ mode: { name: 'computer-control' } });
    await expect(
      resolveLaunchSelection({ ...base, identity: 'personal', cwd: 'C:/cloned/repo' }),
    ).resolves.toMatchObject({ mode: { name: 'developer' } });
    await expect(
      resolveLaunchSelection({ ...base, identity: 'personal', cwd: 'C:/projects/repo' }),
    ).resolves.toMatchObject({ mode: { name: 'project' } });

    const misleading = structuredClone(config);
    misleading.contentScopes['assistant-input'] = {
      roots: ['C:/projects'],
      skillPacks: ['core', 'personal'],
    };
    await expect(
      resolveLaunchSelection({
        ...base,
        userConfig: misleading,
        identity: 'personal',
        cwd: 'C:/projects/repo',
      }),
    ).resolves.toMatchObject({
      mode: { name: 'project' },
      contentScope: { name: 'assistant-input' },
      cwdClassification: { domain: 'personal', contentScope: 'assistant-input' },
    });

    const missing = structuredClone(config);
    delete missing.modes['personal-assistant'];
    await expect(
      resolveLaunchSelection({
        ...base,
        userConfig: missing,
        identity: 'personal',
        cwd: 'C:/assistant/input/note',
      }),
    ).rejects.toMatchObject({ code: 'MODE_UNKNOWN' });
  });

  it('allows explicitly selected personal-assistant and supported OSS developer modes, but still requires grants for inferred project mode', async () => {
    const assistant = await resolveLaunch({
      ...unboundBase,
      identity: 'personal',
      mode: 'personal-assistant',
      cwd: 'C:/assistant/input/note',
      skillArtifact: artifact({ contentScope: 'assistant-input', projectId: null }),
    });
    expect(assistant).toMatchObject({
      mode: 'personal-assistant',
      grants: [],
      cwdClassification: { domain: 'assistant-input', contentScope: 'assistant-input' },
    });

    const developer = await resolveLaunch({
      ...unboundBase,
      identity: 'personal',
      cwd: 'C:/cloned/repo',
      skillArtifact: artifact({
        contentScope: 'cloned-repositories',
        projectId: null,
        enabledPacks: ['core', 'work'],
      }),
    });
    expect(developer).toMatchObject({
      mode: 'developer',
      grants: [],
      cwdClassification: { domain: 'oss', contentScope: 'cloned-repositories' },
    });

    const crossDomainProject = {
      ...base,
      identity: 'personal',
      cwd: 'C:/work/repo',
      projectId: 'work/app',
      skillArtifact: artifact({
        contentScope: 'work',
        projectId: 'work/app',
        enabledPacks: ['core', 'work'],
      }),
    };
    const expectedMismatch = {
      code: 'IDENTITY_DOMAIN_MISMATCH',
      message:
        "Identity 'personal' cannot launch in domain 'work' without an explicit grant. To grant read/write access, run: mpx launch pi --identity personal --grant rw:work --reason \"Allow personal identity in work domain\"",
    };
    await expect(resolveLaunch(crossDomainProject)).rejects.toMatchObject(expectedMismatch);
    await expect(resolveLaunch({ ...crossDomainProject, mode: 'developer' })).rejects.toMatchObject(
      expectedMismatch,
    );
  });

  it('uses developer only for application-authorized missing work config while preserving strict explicit intent', async () => {
    await expect(
      resolveLaunchSelection({
        ...base,
        identity: 'work',
        cwd: 'C:/work/unconfigured',
        automaticModeFallback: 'missing-project-config',
      }),
    ).resolves.toMatchObject({
      mode: { name: 'developer' },
      provenance: { mode: 'automatic-fallback' },
    });
    await expect(
      resolveLaunchSelection({
        ...base,
        identity: 'work',
        cwd: 'C:/work/unconfigured',
        mode: 'project',
        automaticModeFallback: 'missing-project-config',
      }),
    ).resolves.toMatchObject({ mode: { name: 'project' }, provenance: { mode: 'explicit' } });
    await expect(
      resolveLaunchSelection({
        ...base,
        identity: 'work',
        cwd: 'C:/work/unconfigured',
        preset: 'work',
        automaticModeFallback: 'missing-project-config',
      }),
    ).resolves.toMatchObject({ mode: { name: 'project' }, preset: 'work' });
  });

  it('rejects unbound personal/work domain mismatches before project-required diagnostics', async () => {
    await expect(
      resolveLaunch({
        ...unboundBase,
        identity: 'personal',
        cwd: 'C:/work/unbound',
        mode: 'project',
        skillArtifact: artifact({
          projectId: null,
          identity: 'personal',
          contentScope: 'work',
        }),
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_DOMAIN_MISMATCH' });
  });

  it('requires a canonical project id for project mode', async () => {
    await expect(
      resolveLaunch({
        ...unboundBase,
        identity: 'personal',
        skillArtifact: artifact({ projectId: null }),
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_REQUIRED' });
  });

  it('accepts policy-narrowed artifact packs when they match the resolved effective policy', async () => {
    const narrowed = structuredClone(config);
    narrowed.skillPolicies.developer = {
      skillPacks: ['core'],
      skillExposure: { default: 'name-only' },
    };
    const descriptor = await resolveLaunch({
      ...base,
      userConfig: narrowed,
      identity: 'personal',
      skillPolicy: 'developer',
      skillArtifact: artifact({
        skillPolicy: 'developer',
        skillPolicyConfig: narrowed.skillPolicies.developer as never,
        enabledPacks: ['core'],
      }),
    });
    expect(descriptor.skillArtifact.enabledPacks).toEqual(['core']);
  });

  it('requires a separate exact trusted approval and human reason for every requested grant, including read-only', async () => {
    const requested = {
      ...base,
      cwd: 'C:/work/repo',
      identity: 'personal',
      projectId: 'work/app',
      grants: ['ro:work'],
      reason: 'Inspect work project',
      skillArtifact: artifact({
        contentScope: 'work',
        projectId: 'work/app',
        enabledPacks: ['core', 'work'],
      }),
    } as const;
    await expect(resolveLaunch(requested)).rejects.toMatchObject({
      code: 'GRANT_APPROVAL_REQUIRED',
    });
    await expect(
      resolveLaunch({
        ...requested,
        grantApprovals: [
          {
            access: 'rw',
            resource: 'work',
            reason: 'Inspect work project',
            approvalKey: hash('a'),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'GRANT_APPROVAL_REQUIRED' });
    await expect(
      resolveLaunch({
        ...requested,
        grantApprovals: [{ access: 'ro', resource: 'work', reason: '', approvalKey: hash('a') }],
      }),
    ).rejects.toMatchObject({ code: 'GRANT_APPROVAL_REQUIRED' });
    await expect(
      resolveLaunch({
        ...requested,
        grantApprovals: [
          {
            access: 'ro',
            resource: 'work',
            reason: 'Inspect work project',
            approvalKey: 'unverified',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'GRANT_APPROVAL_REQUIRED' });
    const granted = await resolveLaunch({
      ...requested,
      grantApprovals: [
        { access: 'ro', resource: 'work', reason: 'Inspect work project', approvalKey: hash('a') },
      ],
    });
    expect(granted.grants).toEqual([{ access: 'ro', resource: 'work' }]);
  });

  it('downgrades cross-domain project access to read-only unless the matching grant is explicit rw', async () => {
    const requested = {
      ...base,
      cwd: 'C:/work/repo',
      identity: 'personal',
      projectId: 'work/app',
      reason: 'Inspect work project',
      skillArtifact: artifact({
        contentScope: 'work',
        projectId: 'work/app',
        enabledPacks: ['core', 'work'],
      }),
    };
    const readOnly = await resolveLaunch({
      ...requested,
      grants: ['work'],
      grantApprovals: [
        { access: 'ro', resource: 'work', reason: requested.reason, approvalKey: hash('a') },
      ],
    });
    expect(readOnly.intendedPolicy.resources).toEqual({ 'selected-project': 'read-only' });
    const readWrite = await resolveLaunch({
      ...requested,
      grants: ['rw:work'],
      grantApprovals: [
        { access: 'rw', resource: 'work', reason: requested.reason, approvalKey: hash('b') },
      ],
    });
    expect(readWrite.intendedPolicy.resources).toEqual({ 'selected-project': 'read-write' });
  });

  it('parses only resource grants with explicit ro/rw access while defaulting omitted cross-domain access to ro', () => {
    expect(parseGrant('ro:work')).toEqual({ access: 'ro', resource: 'work' });
    expect(parseGrant('rw:assistant-output')).toEqual({
      access: 'rw',
      resource: 'assistant-output',
    });
    expect(parseGrant('work')).toEqual({ access: 'ro', resource: 'work' });
    expect(() => parseGrant('write:C:/work')).toThrow(
      expect.objectContaining({ code: 'GRANT_INVALID' }),
    );
  });

  it('requires a nonempty reason for read/write grants or unrestricted mode and stores only a sanitized reason', async () => {
    await expect(
      resolveLaunch({ ...base, identity: 'personal', grants: ['rw:personal'] }),
    ).rejects.toMatchObject({ code: 'ELEVATION_REASON_REQUIRED' });
    await expect(
      resolveLaunch({ ...base, identity: 'personal', mode: 'unrestricted', reason: '  ' }),
    ).rejects.toMatchObject({ code: 'ELEVATION_REASON_REQUIRED' });
    const elevatedReason = 'Need output at C:/Users/me/private token=abc123';
    const elevated = await resolveLaunch({
      ...base,
      identity: 'personal',
      grants: ['rw:personal'],
      reason: elevatedReason,
      grantApprovals: [
        { access: 'rw', resource: 'personal', reason: elevatedReason, approvalKey: hash('a') },
      ],
    });
    expect(elevated.elevationAudit).toMatchObject({
      elevated: true,
      reason: 'Need output at [path] token=[redacted]',
    });
  });

  it('requires a separate trusted approval for unrestricted mode elevation', async () => {
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        mode: 'unrestricted',
        reason: 'Need host access',
      }),
    ).rejects.toMatchObject({ code: 'GRANT_APPROVAL_REQUIRED' });
  });

  it('emits persistent sanitized elevation banner/audit data without raw approval details', async () => {
    const rawReason = 'Need C:/private/file; token=raw-secret';
    const descriptor = await resolveLaunch({
      ...base,
      identity: 'personal',
      grants: ['ro:personal'],
      reason: rawReason,
      grantApprovals: [
        { access: 'ro', resource: 'personal', reason: rawReason, approvalKey: hash('a') },
      ],
    });
    expect(descriptor.elevationAudit).toEqual({
      elevated: true,
      reason: 'Need [path]; token=[redacted]',
      approvalsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      banner: {
        code: 'ELEVATED_LAUNCH',
        persistent: true,
        message: 'ELEVATED LAUNCH — ro:personal — Need [path]; token=[redacted]',
      },
    });
    expect(JSON.stringify(descriptor.elevationAudit)).not.toContain('raw-secret');
  });

  it('keeps unavailable Docker selected with actionable projected diagnostics and never falls back to host', async () => {
    const docker = await resolveLaunch({
      ...base,
      identity: 'personal',
      dockerAvailability: 'unavailable',
    });
    expect(docker.executor).toMatchObject({
      name: 'docker',
      availability: 'unavailable',
      effectiveEnforcement: 'mount-enforced',
      isolation: 'container',
      interception: {
        kind: 'container-boundary',
        knownBypasses: ['host-services', 'direct-extra-mounts'],
      },
      mounts: { kind: 'explicit', policyEnforced: true },
      confidentiality: { isolated: 'mount-dependent', hostReadable: true },
    });
    expect(docker.diagnostics).toEqual([
      expect.objectContaining({
        code: 'DOCKER_UNAVAILABLE',
        status: 'projected',
        remediation: expect.stringContaining('Do not fall back to host'),
      }),
    ]);
  });

  it('requires explicit trusted host compatibility approval and rejects host plus clone', async () => {
    await expect(
      resolveLaunch({ ...base, identity: 'personal', executor: 'host' }),
    ).rejects.toMatchObject({ code: 'HOST_CLONE_UNSUPPORTED' });
    const request = {
      ...base,
      identity: 'personal',
      executor: 'host' as const,
      workspace: 'direct' as const,
      reason: 'Legacy host tool',
    };
    await expect(resolveLaunch(request)).rejects.toMatchObject({ code: 'HOST_APPROVAL_REQUIRED' });
    const host = await resolveLaunch({
      ...request,
      hostApproval: { reason: request.reason, approvalKey: hash('a') },
    });
    expect(host).toMatchObject({
      executor: { name: 'host', effectiveEnforcement: 'advisory' },
      elevationAudit: { elevated: true, banner: { code: 'ELEVATED_LAUNCH', persistent: true } },
    });
  });

  it('keeps the selected symbolic mode resource matrix, effective enforcement, and CWD classification as separate immutable facts', async () => {
    const selected = structuredClone(config);
    selected.modes.project = { resources: { 'selected-project': 'read-only' } };
    const descriptor = await resolveLaunch({ ...base, userConfig: selected, identity: 'personal' });
    expect(descriptor.intendedPolicy).toMatchObject({
      mode: 'project',
      resources: { 'selected-project': 'read-only' },
    });
    expect(descriptor.executor.effectiveEnforcement).toBe('mount-enforced');
    expect(descriptor.cwdClassification).toEqual({ domain: 'personal', contentScope: 'personal' });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.intendedPolicy)).toBe(true);
    expect(Object.isFrozen(descriptor.intendedPolicy.resources)).toBe(true);
    expect(Object.isFrozen(descriptor.executor.interception.knownBypasses)).toBe(true);
    expect(Object.isFrozen(descriptor.skillArtifact)).toBe(true);
    expect(Object.isFrozen(descriptor.networkPolicy)).toBe(true);
    expect(Object.isFrozen(descriptor.provenance)).toBe(true);

    const changed = structuredClone(selected);
    changed.modes.project = { resources: { 'selected-project': 'read-write' } };
    expect(
      (await resolveLaunch({ ...base, userConfig: changed, identity: 'personal' })).launchKey,
    ).not.toBe(descriptor.launchKey);
  });

  it('derives a deterministic launchKey while varying each resolved tuple input one axis at a time', async () => {
    const enabled = structuredClone(config);
    enabled.executors.docker = {};
    enabled.identities.alternate = structuredClone(enabled.identities.personal!);
    enabled.presets.equivalent = {
      identity: 'personal',
      mode: 'project',
      skillPolicy: 'clean',
      contentScope: 'personal',
      executor: 'docker',
      workspace: 'clone',
      networkPolicy: 'implementation',
    };
    const common = {
      ...base,
      userConfig: enabled,
      identity: 'personal',
      mode: 'project',
      skillPolicy: 'clean',
      contentScope: 'personal',
      executor: 'docker' as const,
      workspace: 'clone' as const,
      networkPolicy: 'implementation',
    };
    const original = await resolveLaunch(common);
    const routeVariant = (field: 'git' | 'provider' | 'ssh' | 'mcp') => {
      const userConfig = structuredClone(enabled);
      if (field === 'git') {
        userConfig.identities.personal!.gitAuthorRoute = 'git-other';
      }
      if (field === 'provider') {
        userConfig.identities.personal!.providerRoutes = { github: 'gh-other' };
      }
      if (field === 'ssh') {
        userConfig.identities.personal!.sshRoute = 'ssh-other';
      }
      if (field === 'mcp') {
        userConfig.identities.personal!.mcpSharing = {
          allow: ['other-mcp'],
          shareNativeAuth: false,
        };
      }
      return resolveLaunch({ ...common, userConfig });
    };
    const variants = await Promise.all([
      resolveLaunch({
        ...common,
        runtime: 'claude',
        selectedNativeRuntimeRoot: 'C:/native/claude',
        skillArtifact: artifact({ runtime: 'claude' }),
      }),
      resolveLaunch({
        ...common,
        identity: 'alternate',
        skillArtifact: artifact({ identity: 'alternate' }),
      }),
      resolveLaunch({ ...common, mode: 'developer' }),
      resolveLaunch({
        ...common,
        skillPolicy: 'developer',
        skillArtifact: artifact({
          skillPolicy: 'developer',
          skillPolicyConfig: enabled.skillPolicies.developer as never,
        }),
      }),
      resolveLaunch({
        ...common,
        contentScope: 'team',
        skillArtifact: artifact({ contentScope: 'team', enabledPacks: ['core'] }),
      }),
      resolveLaunch({
        ...common,
        executor: 'host',
        workspace: 'direct',
        reason: 'Legacy host tool',
        hostApproval: { reason: 'Legacy host tool', approvalKey: hash('c') },
      }),
      resolveLaunch({ ...common, workspace: 'host-worktree' }),
      resolveLaunch({ ...common, networkPolicy: 'minimal' }),
      resolveLaunch({ ...common, preset: 'equivalent' }),
      resolveLaunch({
        ...common,
        grants: ['ro:personal'],
        reason: 'Inspect personal',
        grantApprovals: [
          {
            access: 'ro',
            resource: 'personal',
            reason: 'Inspect personal',
            approvalKey: hash('a'),
          },
        ],
      }),
      resolveLaunch({ ...common, cwd: 'C:/projects/team/repo' }),
      routeVariant('git'),
      routeVariant('provider'),
      routeVariant('ssh'),
      routeVariant('mcp'),
      resolveLaunch({ ...common, policyInputs: { policyVersion: 2 } }),
      resolveLaunch({ ...common, skillArtifact: artifact({ catalogHash: hash('5') }) }),
      (() => {
        const userConfig = structuredClone(enabled);
        userConfig.contentScopes.personal!.skillPacks = ['core'];
        return resolveLaunch({
          ...common,
          userConfig,
          skillArtifact: artifact({ enabledPacks: ['core'] }),
        });
      })(),
    ]);
    expect(variants.every((variant) => variant.launchKey !== original.launchKey)).toBe(true);

    const elevated = {
      ...common,
      grants: ['ro:personal'],
      reason: 'Reason one',
      grantApprovals: [
        {
          access: 'ro' as const,
          resource: 'personal',
          reason: 'Reason one',
          approvalKey: hash('a'),
        },
      ],
    };
    const elevatedOriginal = await resolveLaunch(elevated);
    const reasonVariant = await resolveLaunch({
      ...elevated,
      reason: 'Reason two',
      grantApprovals: [{ ...elevated.grantApprovals[0]!, reason: 'Reason two' }],
    });
    const approvalVariant = await resolveLaunch({
      ...elevated,
      grantApprovals: [{ ...elevated.grantApprovals[0]!, approvalKey: hash('b') }],
    });
    expect(reasonVariant.launchKey).not.toBe(elevatedOriginal.launchKey);
    expect(approvalVariant.launchKey).not.toBe(elevatedOriginal.launchKey);

    const deterministic = await resolveLaunch({ ...common, policyInputs: { z: 1, a: 2 } });
    const reordered = await resolveLaunch({ ...common, policyInputs: { a: 2, z: 1 } });
    expect(deterministic.launchKey).toBe(reordered.launchKey);
  });

  it('serializes public and audit views without prompts, secrets, auth/private-key paths, or native roots', async () => {
    const descriptor = await resolveLaunch({
      ...base,
      identity: 'personal',
      grants: ['rw:personal'],
      reason: 'Need generated output; secret=hidden',
      grantApprovals: [
        {
          access: 'rw',
          resource: 'personal',
          reason: 'Need generated output; secret=hidden',
          approvalKey: hash('a'),
        },
      ],
      policyInputs: {
        policyVersion: 1,
        prompt: 'private prompt',
        nativeRoot: 'C:/native/claude',
        nested: { authPath: 'C:/native/auth.json', projectId: 'acme/app' },
      },
      skillArtifact: {
        ...base.skillArtifact,
        token: 'secret-token',
        privateKeyPath: 'C:/keys/id_ed25519',
      } as typeof base.skillArtifact,
    });
    const descriptorText = JSON.stringify(descriptor);
    const publicText = JSON.stringify(serializeLaunchPublic(descriptor));
    const audit = serializeLaunchAudit(descriptor);
    const auditText = JSON.stringify(audit);
    for (const forbidden of [
      'private prompt',
      'hidden',
      'secret-token',
      'C:/native',
      'id_ed25519',
    ]) {
      expect(descriptorText).not.toContain(forbidden);
      expect(publicText).not.toContain(forbidden);
      expect(auditText).not.toContain(forbidden);
    }
    expect(publicText).toContain('gh-personal');
    expect(serializeLaunchPublic(descriptor)).toMatchObject({
      workspace: 'clone',
      networkPolicy: { name: 'implementation' },
      provenance: { runtime: 'explicit', identity: 'explicit' },
    });
    expect(audit.elevationAudit.reason).toBe('Need generated output; secret=[redacted]');
  });

  it('rejects contradictory access levels for the same grant resource', async () => {
    await expect(
      resolveLaunch({
        ...base,
        identity: 'personal',
        grants: ['ro:personal', 'rw:personal'],
        reason: 'Need writes',
      }),
    ).rejects.toMatchObject({ code: 'GRANT_CONFLICT' });
  });

  it('rejects path-bearing, private-key, and secret-bearing route values', async () => {
    for (const route of ['C:/keys/id_ed25519', 'id_ed25519', 'github-token-secret']) {
      const unsafe = structuredClone(config);
      unsafe.identities.personal!.sshRoute = route;
      await expect(
        resolveLaunch({ ...base, userConfig: unsafe, identity: 'personal' }),
      ).rejects.toMatchObject({ code: 'ROUTE_LABEL_INVALID' });
    }
  });
});
