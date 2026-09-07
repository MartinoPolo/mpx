import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  planPiInvocation as planRawPiInvocation,
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

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const projectionLaunchBinding = {
  launchKey: 'a'.repeat(64),
  descriptorDigest: 'b'.repeat(64),
  runtimeArtifactKey: 'd'.repeat(64),
  runtime: 'pi' as const,
  manifestKey: 'c'.repeat(64),
};
const projectionDirectory = mkdtempSync(path.join(tmpdir(), 'pi-invocation-projection-'));
const agentBytes = Buffer.from('compiled agent\n');
const canonicalSkillBytes = Buffer.from('canonical skill\n');
const projectSkillBytes = Buffer.from('project skill\n');
const managedPromptBytes = Buffer.from('managed prompt\n');
const contentFiles = [
  { relativePath: 'agents/Explore.md', bytes: agentBytes },
  { relativePath: 'skills/mpx-canonical/SKILL.md', bytes: canonicalSkillBytes },
  { relativePath: 'skills/project-skill/SKILL.md', bytes: projectSkillBytes },
].map((file) => ({
  ...file,
  sha256: createHash('sha256').update(file.bytes).digest('hex'),
  byteCount: file.bytes.byteLength,
}));
const activeManifest = {
  schemaVersion: 1,
  compilerVersion: '1.0.0',
  runtime: 'pi',
  profileSchemaVersion: 1,
  binding: { projectId: 'sample/app', repositoryId: 'sample/app', contentScope: 'work' },
  manifestKey: 'c'.repeat(64),
  manifestEnvelope: { path: 'active-content.json', includedInFileMap: false },
  skills: [
    {
      identity: 'mpx-canonical',
      exposure: 'full',
      canonicalDescription: 'Canonical.',
      effectiveDescription: 'Canonical.',
      sourcePath: 'content/skills/mpx-canonical/SKILL.md',
      generatedPath: 'skills/mpx-canonical/SKILL.md',
      generatedSha256: contentFiles[1]!.sha256,
      bodyByteOffset: 0,
      omittedOptionalFeatures: [],
    },
    {
      identity: 'project-skill',
      exposure: 'full',
      canonicalDescription: 'Project.',
      effectiveDescription: 'Project.',
      sourcePath: '.agents/skills/project-skill/SKILL.md',
      generatedPath: 'skills/project-skill/SKILL.md',
      generatedSha256: contentFiles[2]!.sha256,
      bodyByteOffset: 0,
      omittedOptionalFeatures: [],
    },
  ],
  agents: [
    {
      canonicalIdentity: 'mpx-explorer',
      projectedIdentity: 'Explore',
      semanticModel: 'standard',
      concreteModel: 'sonnet',
      thinking: 'medium',
      capabilities: ['read'],
      tools: ['read'],
      nesting: { canonical: [], projected: [], requiredTools: [] },
      outputSchema: 'text',
      sourcePath: 'agents/mpx-explorer.md',
      sourceSha256: 'f'.repeat(64),
      sourceByteCount: 1,
      generatedPath: 'agents/Explore.md',
      generatedSha256: contentFiles[0]!.sha256,
      generatedByteCount: contentFiles[0]!.byteCount,
    },
  ],
  files: contentFiles.map((file) => ({
    relativePath: file.relativePath,
    sha256: file.sha256,
    byteCount: file.byteCount,
  })),
};
const activeManifestBytes = Buffer.from(`${JSON.stringify(activeManifest, null, 2)}\n`);
const projectionFileMap = [
  {
    path: 'active-content.json',
    sha256: createHash('sha256').update(activeManifestBytes).digest('hex'),
    bytes: activeManifestBytes.byteLength,
  },
  ...contentFiles.map((file) => ({
    path: file.relativePath,
    sha256: file.sha256,
    bytes: file.byteCount,
  })),
  {
    path: 'instructions/pi/MANAGED_PROMPT.md',
    sha256: createHash('sha256').update(managedPromptBytes).digest('hex'),
    bytes: managedPromptBytes.byteLength,
  },
];
const projectionFileMapHash = digest(projectionFileMap);
const projectionReference: PublishedRuntimeArtifactReference = {
  projectionKey: digest({
    schemaVersion: 1,
    launchBinding: projectionLaunchBinding,
    fileMapHash: projectionFileMapHash,
  }),
  launchBinding: projectionLaunchBinding,
  fileMapHash: projectionFileMapHash,
};
mkdirSync(path.join(projectionDirectory, 'agents'));
mkdirSync(path.join(projectionDirectory, 'instructions', 'pi'), { recursive: true });
mkdirSync(path.join(projectionDirectory, 'skills', 'mpx-canonical'), { recursive: true });
mkdirSync(path.join(projectionDirectory, 'skills', 'project-skill'), { recursive: true });
writeFileSync(path.join(projectionDirectory, 'active-content.json'), activeManifestBytes);
writeFileSync(
  path.join(projectionDirectory, 'instructions', 'pi', 'MANAGED_PROMPT.md'),
  managedPromptBytes,
);
for (const file of contentFiles) {
  writeFileSync(path.join(projectionDirectory, ...file.relativePath.split('/')), file.bytes);
}
writeFileSync(
  path.join(projectionDirectory, '.mpx-runtime-artifact.json'),
  JSON.stringify({ schemaVersion: 1, reference: projectionReference, fileMap: projectionFileMap }),
);
process.on('exit', () => rmSync(projectionDirectory, { recursive: true, force: true }));
const publishedProjection = {
  immutableProjectionDirectory: projectionDirectory,
  projectionReference,
};
const planPiInvocation = (input: Parameters<typeof planRawPiInvocation>[0]) =>
  planRawPiInvocation({ ...publishedProjection, ...input });

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

it('does not disable native extension discovery', async () => {
  const plan = await planPiInvocation({
    executable: 'C:/trusted/pi.cmd',
    profile: invocationProfile,
    accountRoot: 'C:/native/pi/account-a',
    runtimeContextFile: 'C:/launch/context.json',
    runtimeContext,
    cwd: 'C:/repo',
  });

  expect(plan.args).not.toContain('--no-extensions');
  expect(plan.args).not.toContain('--extension');
});

it('creates a hermetic Pi invocation with launch-current-compatible runtime-context JSON', async () => {
  const plan = await planPiInvocation({
    executable: 'C:/trusted/pi.cmd',
    profile: invocationProfile,
    accountRoot: 'C:/native/pi/account-a',
    runtimeContextFile: 'C:/launch/context.json',
    runtimeContext,
    cwd: 'C:/repo',
  });
  expect(plan).toEqual({
    executable: 'C:/trusted/pi.cmd',
    cwd: 'C:/repo',
    args: [
      '--no-skills',
      '--no-context-files',
      '--append-system-prompt',
      path
        .join(projectionDirectory, 'instructions', 'pi', 'MANAGED_PROMPT.md')
        .replaceAll('\\', '/'),
      '--skill',
      path.join(projectionDirectory, 'skills', 'project-skill').replaceAll('\\', '/'),
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.6-sol',
      '--thinking',
      'medium',
      '--tui-mode',
      'fullscreen',
      '--use-theme',
      'dark',
    ],
    env: {
      PI_CODING_AGENT_DIR: 'C:/native/pi/account-a',
      MPX_RUNTIME: 'pi',
      MPX_RUNTIME_CONTEXT: JSON.stringify(runtimeContext),
      MPX_RUNTIME_CONTEXT_FILE: 'C:/launch/context.json',
      MPX_ACTIVE_CONTENT_ROOT: projectionDirectory.replaceAll('\\', '/'),
      MPX_ACTIVE_CONTENT_MANIFEST: path
        .join(projectionDirectory, 'active-content.json')
        .replaceAll('\\', '/'),
      MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY: JSON.stringify({
        sha256: projectionFileMap[0]!.sha256,
        byteCount: projectionFileMap[0]!.bytes,
      }),
      MPX_COMPILED_AGENTS_DIR: path.join(projectionDirectory, 'agents').replaceAll('\\', '/'),
      MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(projectionReference),
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

it('does not expose a canonical-only skill manifest through native --skill', async () => {
  const canonicalOnly = { ...activeManifest, skills: [activeManifest.skills[0]!] };
  const manifestBytes = Buffer.from(`${JSON.stringify(canonicalOnly, null, 2)}\n`);
  const fileMap = [
    {
      path: 'active-content.json',
      sha256: createHash('sha256').update(manifestBytes).digest('hex'),
      bytes: manifestBytes.byteLength,
    },
    ...projectionFileMap.slice(1),
  ];
  const fileMapHash = digest(fileMap);
  const reference = {
    projectionKey: digest({
      schemaVersion: 1,
      launchBinding: projectionLaunchBinding,
      fileMapHash,
    }),
    launchBinding: projectionLaunchBinding,
    fileMapHash,
  };
  try {
    writeFileSync(path.join(projectionDirectory, 'active-content.json'), manifestBytes);
    writeFileSync(
      path.join(projectionDirectory, '.mpx-runtime-artifact.json'),
      JSON.stringify({ schemaVersion: 1, reference, fileMap }),
    );
    const plan = await planRawPiInvocation({
      executable: 'C:/trusted/pi.cmd',
      profile: invocationProfile,
      accountRoot: 'C:/native/pi/account-a',
      runtimeContextFile: 'C:/launch/context.json',
      runtimeContext,
      cwd: 'C:/repo',
      immutableProjectionDirectory: projectionDirectory,
      projectionReference: reference,
    });
    expect(plan.args).toContain('--no-skills');
    expect(plan.args).not.toContain('--skill');
  } finally {
    writeFileSync(path.join(projectionDirectory, 'active-content.json'), activeManifestBytes);
    writeFileSync(
      path.join(projectionDirectory, '.mpx-runtime-artifact.json'),
      JSON.stringify({
        schemaVersion: 1,
        reference: projectionReference,
        fileMap: projectionFileMap,
      }),
    );
  }
});

async function writeProjectSkill(root: string, name: string, metadata = ''): Promise<string> {
  const directory = path.join(root, '.agents', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Native guidance\nallowed-tools: Read, Bash(pnpm *)\n${metadata}\n---\nBody.\n`,
  );
  return directory.replaceAll('\\', '/');
}

it('adds only individually contained native cwd skills beside generated managed project skills', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-native-project-'));
  try {
    const native = await writeProjectSkill(
      cwd,
      'native-skill',
      'metadata:\n    author: Someone\n    version: "1.0"',
    );
    const canonicalName = await writeProjectSkill(cwd, 'mpx-canonical');
    const managedOff = await writeProjectSkill(
      cwd,
      'managed-off',
      'metadata:\n  mpx:\n    projectExposure: full',
    );
    const managedProjected = await writeProjectSkill(
      cwd,
      'project-skill',
      'metadata:\n  mpx:\n    projectExposure: full',
    );
    const plan = await planPiInvocation({
      executable: 'C:/trusted/pi.cmd',
      profile: invocationProfile,
      accountRoot: 'C:/native/pi/account-a',
      runtimeContextFile: 'C:/launch/context.json',
      runtimeContext,
      cwd,
    });
    const directories = plan.args.flatMap((argument, index) =>
      argument === '--skill' ? [plan.args[index + 1]] : [],
    );
    expect(plan.args).toContain('--no-skills');
    expect(directories).toEqual([
      path.join(projectionDirectory, 'skills', 'project-skill').replaceAll('\\', '/'),
      `${canonicalName}/SKILL.md`,
      `${native}/SKILL.md`,
    ]);
    expect(directories).not.toContain(path.join(cwd, '.agents', 'skills').replaceAll('\\', '/'));
    expect(directories).not.toContain(
      path.join(projectionDirectory, 'skills').replaceAll('\\', '/'),
    );
    expect(directories).not.toContain(
      path.join(projectionDirectory, 'skills', 'mpx-canonical').replaceAll('\\', '/'),
    );
    expect(directories).not.toContain(managedOff);
    expect(directories).not.toContain(managedProjected);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it.each([
  'metadata:\n  mpx: null',
  'metadata:\n  "mpx": null',
  'metadata: {mpx: {projectExposure: full}}',
  'metadata:\n  mpx: null\n  mpx:\n    projectExposure: full',
])(
  'rechecks native cwd ownership at every invocation and never falls back: %s',
  async (metadata) => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'pi-native-recheck-'));
    try {
      const directory = await writeProjectSkill(cwd, 'native-skill');
      const input = {
        executable: 'C:/trusted/pi.cmd',
        profile: invocationProfile,
        accountRoot: 'C:/native/pi/account-a',
        runtimeContextFile: 'C:/launch/context.json',
        runtimeContext,
        cwd,
      };
      expect((await planPiInvocation(input)).args).toContain(`${directory}/SKILL.md`);
      await writeProjectSkill(cwd, 'native-skill', metadata);
      await expect(planPiInvocation(input)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'PROJECT_SKILL_INVALID' })],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

it('does not expose a previously managed project skill twice after ownership changes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-native-ownership-'));
  try {
    await writeProjectSkill(cwd, 'project-skill');
    await expect(
      planPiInvocation({
        executable: 'C:/trusted/pi.cmd',
        profile: invocationProfile,
        accountRoot: 'C:/native/pi/account-a',
        runtimeContextFile: 'C:/launch/context.json',
        runtimeContext,
        cwd,
      }),
    ).rejects.toThrow('project skill ownership changed since projection');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('rejects native cwd directories containing linked support files at invocation', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-native-containment-'));
  try {
    const directory = await writeProjectSkill(cwd, 'native-skill');
    await writeFile(path.join(cwd, 'outside.txt'), 'outside');
    await symlink(path.join(cwd, 'outside.txt'), path.join(directory, 'linked.txt'), 'file');
    await expect(
      planPiInvocation({
        executable: 'C:/trusted/pi.cmd',
        profile: invocationProfile,
        accountRoot: 'C:/native/pi/account-a',
        runtimeContextFile: 'C:/launch/context.json',
        runtimeContext,
        cwd,
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'PROJECT_SKILL_INVALID' })],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('fails invocation when the launch-selected active manifest bytes change', async () => {
  try {
    writeFileSync(
      path.join(projectionDirectory, 'active-content.json'),
      Buffer.concat([activeManifestBytes, Buffer.from(' ')]),
    );
    await expect(
      planPiInvocation({
        executable: 'C:/trusted/pi.cmd',
        profile: invocationProfile,
        accountRoot: 'C:/native/pi/account-a',
        runtimeContextFile: 'C:/launch/context.json',
        runtimeContext,
        cwd: 'C:/repo',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT_TAMPERED' });
  } finally {
    writeFileSync(path.join(projectionDirectory, 'active-content.json'), activeManifestBytes);
  }
});

it.each([
  ['personal', 'openai-codex', 'gpt-5.6-sol'],
  ['work', 'anthropic', 'claude-sonnet-4-6'],
] as const)(
  'pins the %s profile instead of consulting ambient native settings',
  async (_identity, provider, model) => {
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
    const plan = await planPiInvocation({
      executable: 'C:/trusted/pi.cmd',
      profile,
      accountRoot: 'C:/native/pi/selected-account',
      runtimeContextFile: 'C:/launch/context.json',
      runtimeContext,
      cwd: 'C:/repo',
    });

    expect(plan.args).toEqual([
      '--no-skills',
      '--no-context-files',
      '--append-system-prompt',
      path
        .join(projectionDirectory, 'instructions', 'pi', 'MANAGED_PROMPT.md')
        .replaceAll('\\', '/'),
      '--skill',
      path.join(projectionDirectory, 'skills', 'project-skill').replaceAll('\\', '/'),
      '--provider',
      provider,
      '--model',
      model,
      '--thinking',
      'medium',
      '--tui-mode',
      'fullscreen',
      '--use-theme',
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
      profile: invocationProfile,
      accountRoot: account,
      runtimeContextFile: path.join(account, 'context.json'),
      runtimeContext,
      cwd: account,
    };
    await expect(planPiInvocation({ ...base, resumeTarget: verified })).resolves.toMatchObject({
      args: expect.arrayContaining([
        '--session',
        path.join(account, 'sessions', 'session-a.jsonl').replaceAll('\\', '/'),
      ]),
    });
    await expect(
      planPiInvocation({ ...base, resumeTarget: {} as typeof verified }),
    ).rejects.toThrow(/verified/u);
    await expect(
      planPiInvocation({
        ...base,
        accountRoot: path.join(account, 'other'),
        resumeTarget: verified,
      }),
    ).rejects.toThrow(/account root/u);
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
it('injects only a full validated Pi lifecycle binding id and directory', async () => {
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
      profile: invocationProfile,
      accountRoot: 'C:/native/pi/account-a',
      runtimeContextFile: 'C:/launch/context.json',
      runtimeContext,
      cwd: 'C:/repo',
    };
  await expect(
    planPiInvocation({ ...base, lifecycle: { eventDirectory: 'C:/events', binding } }),
  ).resolves.toMatchObject({
    env: {
      MPX_SESSION_LIFECYCLE_BINDING_ID: 'binding-1',
      MPX_SESSION_LIFECYCLE_EVENT_DIR: 'C:/events',
    },
  });
  await expect(
    planPiInvocation({
      ...base,
      lifecycle: { eventDirectory: 'C:/events', binding: { ...binding, manifestKey: 'wrong' } },
    }),
  ).rejects.toThrow(/BINDING_MISMATCH/u);
});
it('leaves bridge and status integration to the canonically discovered native package', async () => {
  const plan = await planPiInvocation({
    executable: 'C:/trusted/pi.cmd',
    profile: invocationProfile,
    accountRoot: 'C:/native/pi/account-a',
    runtimeContextFile: 'C:/launch/context.json',
    runtimeContext,
    cwd: 'C:/repo',
  });

  expect(plan.env).not.toHaveProperty('MPX_PI_LAUNCH_PRIVATE_BRIDGE');
  expect(plan.env).not.toHaveProperty('MPX_STATUS_SNAPSHOT_FILE');
  expect(plan.env).not.toHaveProperty('MPX_RUNTIME_STATUS_ENVELOPE_FILE');
});

it('propagates the exact published projection reference as JSON', async () => {
  const plan = await planPiInvocation({
    executable: 'C:/trusted/pi.cmd',
    runtimeContextFile: path.join(projectionDirectory, 'runtime-context.json'),
    profile: invocationProfile,
    accountRoot: 'C:/native/pi/account-a',
    cwd: 'C:/repo',
    runtimeContext,
  });
  expect(plan.env.MPX_RUNTIME_PROJECTION_REFERENCE).toBe(JSON.stringify(projectionReference));
  expect(plan.env.MPX_ACTIVE_CONTENT_ROOT).toBe(projectionDirectory.replaceAll('\\', '/'));
  expect(plan.env.MPX_ACTIVE_CONTENT_MANIFEST).toBe(
    path.join(projectionDirectory, 'active-content.json').replaceAll('\\', '/'),
  );
  expect(plan.env.MPX_COMPILED_AGENTS_DIR).toBe(
    path.join(projectionDirectory, 'agents').replaceAll('\\', '/'),
  );
  expect(path.isAbsolute(plan.env.MPX_COMPILED_AGENTS_DIR!)).toBe(true);
  expect(path.relative(plan.env.MPX_ACTIVE_CONTENT_ROOT!, plan.env.MPX_COMPILED_AGENTS_DIR!)).toBe(
    'agents',
  );
});

it('fails closed when flattened published projection metadata is absent', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-missing-map-'));
  try {
    await expect(
      planRawPiInvocation({
        executable: 'C:/trusted/pi.cmd',
        profile: invocationProfile,
        accountRoot: 'C:/native/pi/account-a',
        immutableProjectionDirectory: directory,
        runtimeContextFile: path.join(directory, 'runtime-context.json'),
        runtimeContext,
        projectionReference,
        cwd: 'C:/repo',
      }),
    ).rejects.toThrow(/file map/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('fails closed when a flattened projection file map has a case-insensitive collision', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-colliding-map-'));
  try {
    mkdirSync(path.join(directory, 'agents'));
    writeFileSync(path.join(directory, 'active-content.json'), '{}\n');
    writeFileSync(path.join(directory, 'agents', 'Explore.md'), 'compiled agent\n');
    const fileMap = [
      { path: 'active-content.json', sha256: '1'.repeat(64), bytes: 3 },
      { path: 'agents/Explore.md', sha256: '2'.repeat(64), bytes: 15 },
      { path: 'AGENTS/explore.md', sha256: '2'.repeat(64), bytes: 15 },
    ];
    const fileMapHash = digest(fileMap);
    const collisionReference = {
      projectionKey: digest({
        schemaVersion: 1,
        launchBinding: projectionLaunchBinding,
        fileMapHash,
      }),
      launchBinding: projectionLaunchBinding,
      fileMapHash,
    };
    writeFileSync(
      path.join(directory, '.mpx-runtime-artifact.json'),
      JSON.stringify({ schemaVersion: 1, reference: collisionReference, fileMap }),
    );

    await expect(
      planRawPiInvocation({
        executable: 'C:/trusted/pi.cmd',
        profile: invocationProfile,
        accountRoot: 'C:/native/pi/account-a',
        immutableProjectionDirectory: directory,
        runtimeContextFile: path.join(directory, 'runtime-context.json'),
        runtimeContext,
        projectionReference: collisionReference,
        cwd: 'C:/repo',
      }),
    ).rejects.toThrow(/collides/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
