import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  inventoryCanonical,
  inventoryProjectSkills,
  resolveManifest,
  type Runtime,
  type SkillProjectionPlan,
} from '@mpx/skills';
import { fileURLToPath } from 'node:url';
import { loadRuntimeProfilesV1, type RuntimeProfilesV1 } from '@mpx/config';
import { compileContent, verifyCompiledContentTree } from '../../src/index.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const runtimeProfiles: RuntimeProfilesV1 = {
  schemaVersion: 1,
  models: {
    claude: {
      mechanical: 'haiku',
      exploration: 'sonnet',
      standard: 'sonnet',
      advanced: 'opus',
      frontier: 'fable',
    },
    pi: {
      mechanical: 'p/m',
      exploration: 'p/m',
      standard: 'p/s',
      advanced: 'p/a',
      frontier: 'p/f',
    },
  },
  agentTranslation: {
    runtimes: {
      claude: {
        aliases: { 'mpx-explorer': 'Explore' },
        capabilities: {
          mappings: {
            read: ['Read'],
            search: ['Grep', 'Glob'],
            shell: ['Bash'],
            write: ['Edit', 'Write'],
            browser: ['mcp__mpx_gateway__mcp'],
            context: ['mcp__mpx_gateway__mcp'],
            web: ['WebSearch', 'WebFetch'],
          },
        },
        frontmatter: {
          model: 'model',
          thinking: 'effort',
          tools: 'tools',
          outputSchema: 'output-schema',
          nesting: 'allowed-subagents',
        },
        separators: { tools: ', ', nesting: ',' },
        nestingRequiredTools: ['Agent'],
      },
      pi: {
        aliases: { 'mpx-explorer': 'Explore' },
        capabilities: {
          mappings: {
            read: ['read'],
            search: ['grep', 'find', 'ls'],
            shell: ['bash'],
            write: ['edit', 'write'],
            browser: ['mcp'],
            context: ['mcp'],
            web: ['web_search', 'fetch_content', 'get_search_content', 'source_check'],
          },
        },
        frontmatter: {
          model: 'model',
          thinking: 'thinking',
          tools: 'tools',
          outputSchema: 'output_schema',
          nesting: 'allowed_subagents',
        },
        separators: { tools: ', ', nesting: ',' },
        nestingRequiredTools: [],
      },
    },
  },
  contentTranslation: {
    nameOnlyDescriptionTemplate:
      'MPX skill {{identity}}. Load only when the user explicitly mentions {{identity}} by name.',
    runtimes: {
      claude: {
        argumentHint: 'supported',
        capabilities: {
          support: 'preapproved',
          mappings: {
            read: ['Read'],
            search: ['Glob', 'Grep'],
            shell: ['Bash'],
            write: ['Write', 'Edit'],
            delegate: ['Agent'],
          },
        },
        frontmatter: { argumentHint: 'argument-hint', capabilityGrant: 'allowed-tools' },
      },
      pi: {
        argumentHint: 'unsupported',
        capabilities: { support: 'unsupported', mappings: {} },
        frontmatter: { argumentHint: null, capabilityGrant: null },
      },
    },
  },
};

async function createAgentFixture(root: string, outputSchema = 'text'): Promise<string> {
  const agentRoot = path.join(root, 'agents');
  await mkdir(path.join(agentRoot, 'references'), { recursive: true });
  await writeFile(
    path.join(agentRoot, 'mpx-explorer.md'),
    '---\nname: mpx-explorer\ndescription: Explore safely.\n---\nAgent body.\nSee [reference](references/guide.md).\n',
  );
  await writeFile(path.join(agentRoot, 'references', 'guide.md'), '# Agent guide\n');
  await writeFile(
    path.join(agentRoot, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      agents: {
        'mpx-explorer': {
          modelClass: 'exploration',
          thinking: 'medium',
          capabilities: ['read', 'search'],
          nesting: [],
          outputSchema,
        },
      },
    }),
  );
  return agentRoot;
}

async function fixture(
  runtime: Runtime,
  options: {
    missingShared?: boolean;
    sharedIdentity?: boolean;
    mixedNewlines?: boolean;
    referenceDefinition?: string;
    unicodeBody?: boolean;
    outputSchema?: string;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-compiler-'));
  roots.push(root);
  const skillsRoot = path.join(root, 'skills');
  const sharedRoot = path.join(root, 'shared');
  const agentRoot = await createAgentFixture(root, options.outputSchema);
  await mkdir(sharedRoot, { recursive: true });
  if (!options.missingShared) {
    await writeFile(path.join(sharedRoot, 'GUIDE.md'), '# Shared\n');
  }
  const definitions = options.sharedIdentity
    ? [['shared', 'full'] as const]
    : ([
        ['alpha', 'full'],
        ['named', 'name-only'],
        ['locked', 'explicit-only'],
        ['gone', 'off'],
      ] as const);
  for (const [identity, exposure] of definitions) {
    await mkdir(path.join(skillsRoot, identity, 'references'), { recursive: true });
    const extra =
      identity === 'alpha'
        ? `argument-hint: <topic>\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n    capabilities: [read, search, shell, write, delegate]\n`
        : `metadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n`;
    const body = options.unicodeBody
      ? `Unicode café 漢字 ${identity}.\r\nSecond line.\n`
      : `Body ${identity}.\nSee [shared](../shared/GUIDE.md).\n${identity === 'alpha' ? (options.referenceDefinition ?? '') : ''}`;
    let source = `---\nname: ${identity}\ndescription: ${identity} exact description\n${extra}---\n${body}`;
    if (options.mixedNewlines) {
      source = source.replace('---\nBody', '---\r\nBody');
    }
    await writeFile(path.join(skillsRoot, identity, 'SKILL.md'), source);
    await writeFile(path.join(skillsRoot, identity, 'references', 'local.md'), '# Local\n');
  }
  const catalog = await inventoryCanonical(skillsRoot);
  const exposures = Object.fromEntries(
    definitions.map(([identity, exposure]) => [identity, exposure]),
  );
  const manifest = resolveManifest(catalog, {
    repositoryId: 'repo',
    contentScope: 'test',
    identity: 'test',
    skillPolicy: 'test',
    skillPolicyConfig: { skillExposure: { default: 'full', skills: exposures } },
    enabledPacks: ['core'],
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime });
  const plan = await createSkillProjectionPlan({
    canonicalRoot: skillsRoot,
    manifest,
    artifact,
    catalog,
  });
  return { plan, sharedRoot, agentRoot };
}

const text = (result: Awaited<ReturnType<typeof compileContent>>, relativePath: string) =>
  Buffer.from(result.files.find((file) => file.relativePath === relativePath)!.bytes).toString(
    'utf8',
  );

describe('shared content compiler', () => {
  it('compiles a representative real canonical corpus against the actual shared directory', async () => {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    const canonicalRoot = path.join(repositoryRoot, 'content', 'skills');
    const catalog = await inventoryCanonical(canonicalRoot);
    const selected = catalog.filter((skill) =>
      ['issue-create', 'review', 'commit'].includes(skill.identity),
    );
    const manifest = resolveManifest(selected, {
      repositoryId: 'mpx',
      contentScope: 'integration',
      identity: 'integration',
      skillPolicy: 'integration',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
      enabledPacks: ['core', 'work'],
    });
    const artifact = createRuntimeSkillArtifact(manifest, selected, { runtime: 'claude' });
    const plan = await createSkillProjectionPlan({
      canonicalRoot,
      manifest,
      artifact,
      catalog: selected,
    });
    const trackedProfiles = await loadRuntimeProfilesV1(
      path.join(repositoryRoot, 'content', 'runtime-profiles.json'),
    );
    const result = await compileContent({
      runtime: 'claude',
      plan,
      runtimeProfiles: trackedProfiles,
      sharedInstructionRoot: path.join(repositoryRoot, 'content', 'instructions', 'shared'),
      agentRoot: path.join(repositoryRoot, 'content', 'agents'),
    });
    expect(result.manifest.skills.map((skill) => skill.identity)).toEqual([
      'commit',
      'issue-create',
      'review',
    ]);
    expect(text(result, 'skills/shared/providers/GITHUB.md')).toContain(
      'gh issue view <id> --repo <target>',
    );
    expect(text(result, 'skills/shared/providers/LOCAL.md')).toContain('schemaVersion: 2');
  });

  it.each([
    [
      'claude',
      "---\nname: Explore\ndescription: Explore safely.\nmodel: 'sonnet'\neffort: 'medium'\ntools: 'Read, Grep, Glob'\noutput-schema: 'text'\n\n---\nAgent body.\nSee [reference](references/guide.md).\n",
    ],
    [
      'pi',
      "---\nname: Explore\ndescription: Explore safely.\nmodel: 'p/m'\nthinking: 'medium'\ntools: 'read, grep, find, ls'\noutput_schema: 'text'\n\n---\nAgent body.\nSee [reference](references/guide.md).\n",
    ],
  ] as const)(
    'compiles a complete deterministic YAML-safe representative %s agent',
    async (runtime, expectedBytes) => {
      const value = await fixture(runtime);
      const result = await compileContent({
        runtime,
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      });
      const generated = text(result, 'agents/Explore.md');
      expect(generated).toBe(expectedBytes);
      expect(result.files.map((file) => file.relativePath)).toContain('agents/references/guide.md');
      expect(result.manifest.agents).toEqual([
        expect.objectContaining({
          canonicalIdentity: 'mpx-explorer',
          projectedIdentity: 'Explore',
          semanticModel: 'exploration',
          concreteModel: runtime === 'claude' ? 'sonnet' : 'p/m',
          thinking: 'medium',
          capabilities: ['read', 'search'],
          generatedPath: 'agents/Explore.md',
          sourcePath: 'mpx-explorer.md',
          outputSchema: 'text',
        }),
      ]);
    },
  );

  it('rejects an output schema that cannot be safely represented as a frontmatter scalar', async () => {
    const value = await fixture('pi', { outputSchema: 'text\nunsafe' });
    await expect(
      compileContent({
        runtime: 'pi',
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      }),
    ).rejects.toThrow(/agent catalog schema is invalid/u);
  });

  it.each([
    ['mismatched', { 'mpx-other': 'mpx-other' }],
    ['extra', { 'mpx-explorer': 'Explore', 'mpx-extra': 'mpx-extra' }],
  ] as const)(
    'rejects %s runtime aliases relative to canonical agents',
    async (_label, aliases) => {
      const value = await fixture('pi');
      const invalid = structuredClone(runtimeProfiles);
      (invalid.agentTranslation.runtimes.pi as { aliases: unknown }).aliases = aliases;
      await expect(
        compileContent({
          runtime: 'pi',
          plan: value.plan,
          runtimeProfiles: invalid,
          sharedInstructionRoot: value.sharedRoot,
          agentRoot: value.agentRoot,
        }),
      ).rejects.toThrow(/aliases must exactly cover canonical agents/u);
    },
  );

  it('projects a project-local skill support files with source provenance', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-project-projection-'));
    roots.push(root);
    const canonicalRoot = path.join(root, 'canonical');
    const projectRoot = path.join(root, 'project');
    await mkdir(canonicalRoot, { recursive: true });
    const localRoot = path.join(projectRoot, '.agents', 'skills', 'local-helper');
    await mkdir(path.join(localRoot, 'references'), { recursive: true });
    await writeFile(
      path.join(localRoot, 'SKILL.md'),
      '---\nname: local-helper\ndescription: Local helper.\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    projectExposure: explicit-only\n---\nSee [guide](references/guide.md).\n',
    );
    await writeFile(path.join(localRoot, 'references', 'guide.md'), '# Guide\n');
    const project = await inventoryProjectSkills(projectRoot);
    expect(project.diagnostics).toEqual([]);
    const manifest = resolveManifest(project.skills, {
      repositoryId: 'repo',
      projectId: 'project',
      contentScope: 'test',
      identity: 'test',
      skillPolicy: 'test',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
      enabledPacks: ['core'],
    });
    const artifact = createRuntimeSkillArtifact(manifest, project.skills, { runtime: 'claude' });
    const plan = await createSkillProjectionPlan({
      canonicalRoot,
      manifest,
      artifact,
      catalog: project.skills,
    });
    const sharedRoot = path.join(root, 'shared');
    const agentRoot = await createAgentFixture(root);
    await mkdir(sharedRoot);
    const result = await compileContent({
      runtime: 'claude',
      plan,
      runtimeProfiles,
      sharedInstructionRoot: sharedRoot,
      agentRoot,
    });
    expect(result.files.map((file) => file.relativePath)).toContain(
      'skills/local-helper/references/guide.md',
    );
    expect(result.manifest.skills[0]?.sourcePath).toBe('.agents/skills/local-helper/SKILL.md');
  });

  it('returns a deterministic sorted final tree and versioned inspection manifest from one API', async () => {
    const value = await fixture('claude');
    const first = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    const second = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    expect(first).toEqual(second);
    expect(first.files.map((file) => file.relativePath)).toEqual(
      first.files.map((file) => file.relativePath).sort(),
    );
    expect(first.manifest).toMatchObject({
      schemaVersion: 1,
      compilerVersion: '1.0.0',
      runtime: 'claude',
    });
  });

  it.each(['claude', 'pi'] as const)(
    'emits native uppercase SKILL.md paths and excludes off entries for %s',
    async (runtime) => {
      const value = await fixture(runtime);
      const result = await compileContent({
        runtime,
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      });
      expect(result.files.some((file) => /body\.md$/iu.test(file.relativePath))).toBe(false);
      expect(
        result.files.filter((file) =>
          /skills\/(?:alpha|named|locked)\/SKILL\.md$/u.test(file.relativePath),
        ),
      ).toHaveLength(3);
      expect(result.files.some((file) => file.relativePath.includes('/gone/'))).toBe(false);
    },
  );

  it.each(['claude', 'pi'] as const)(
    'preserves exact canonical descriptions for full and explicit-only %s output',
    async (runtime) => {
      const value = await fixture(runtime);
      const result = await compileContent({
        runtime,
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      });
      expect(text(result, 'skills/alpha/SKILL.md')).toContain(
        "description: 'alpha exact description'",
      );
      expect(text(result, 'skills/locked/SKILL.md')).toContain(
        "description: 'locked exact description'",
      );
    },
  );

  it.each(['claude', 'pi'] as const)(
    'uses the configured explicit name trigger while retaining model invocation for %s',
    async (runtime) => {
      const value = await fixture(runtime);
      const result = await compileContent({
        runtime,
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      });
      const output = text(result, 'skills/named/SKILL.md');
      expect(output).toContain(
        "description: 'MPX skill named. Load only when the user explicitly mentions named by name.'",
      );
      expect(output).not.toContain('disable-model-invocation');
    },
  );

  it.each(['claude', 'pi'] as const)(
    'disables model invocation for explicit-only %s output',
    async (runtime) => {
      const value = await fixture(runtime);
      const result = await compileContent({
        runtime,
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      });
      expect(text(result, 'skills/locked/SKILL.md')).toContain('disable-model-invocation: true');
    },
  );

  it('emits Claude argument hints and records Pi omission of the unsupported optional feature', async () => {
    const claude = await fixture('claude');
    const claudeResult = await compileContent({
      runtime: 'claude',
      plan: claude.plan,
      runtimeProfiles,
      sharedInstructionRoot: claude.sharedRoot,
      agentRoot: claude.agentRoot,
    });
    expect(text(claudeResult, 'skills/alpha/SKILL.md')).toContain("argument-hint: '<topic>'");
    const pi = await fixture('pi');
    const piResult = await compileContent({
      runtime: 'pi',
      plan: pi.plan,
      runtimeProfiles,
      sharedInstructionRoot: pi.sharedRoot,
      agentRoot: pi.agentRoot,
    });
    expect(text(piResult, 'skills/alpha/SKILL.md')).not.toContain('argument-hint');
    expect(
      piResult.manifest.skills.find((skill) => skill.identity === 'alpha')?.omittedOptionalFeatures,
    ).toEqual(['argument-hint', 'capability-grants']);
  });

  it('omits unsupported Pi grants while preserving optional semantic requirements', async () => {
    const value = await fixture('pi');
    expect(value.plan.entries.find((entry) => entry.identity === 'alpha')?.capabilities).toEqual([
      'delegate',
      'read',
      'search',
      'shell',
      'write',
    ]);
    const result = await compileContent({
      runtime: 'pi',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    expect(text(result, 'skills/alpha/SKILL.md')).not.toContain('allowed-tools');
    expect(result.manifest.skills.find((skill) => skill.identity === 'alpha')).toMatchObject({
      capabilities: ['delegate', 'read', 'search', 'shell', 'write'],
      capabilityGrantsApplied: false,
      capabilityGrantSupport: 'unsupported',
      omittedOptionalFeatures: ['argument-hint', 'capability-grants'],
    });
  });

  it('translates Claude semantic capabilities into least-privilege preapproval grants', async () => {
    const value = await fixture('claude');
    const result = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    expect(text(result, 'skills/alpha/SKILL.md')).toContain(
      'allowed-tools: Agent, Read, Glob, Grep, Bash, Write, Edit',
    );
    expect(result.manifest.skills.find((skill) => skill.identity === 'alpha')).toMatchObject({
      capabilityGrantsApplied: true,
      capabilityGrantSupport: 'preapproved',
    });
  });

  it('fails closed when a required capability grant is unavailable', async () => {
    const value = await fixture('pi');
    await expect(
      compileContent({
        runtime: 'pi',
        plan: value.plan,
        runtimeProfiles,
        requiredCapabilityGrants: ['read'],
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      }),
    ).rejects.toThrow(/required capability grant 'read' is unavailable/u);
  });

  it('copies support and shared files and verifies relative Markdown reference closure', async () => {
    const value = await fixture('claude');
    const result = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    expect(result.files.map((file) => file.relativePath)).toContain(
      'skills/alpha/references/local.md',
    );
    expect(result.files.map((file) => file.relativePath)).toContain('skills/shared/GUIDE.md');
  });

  it('preserves canonical body text unchanged', async () => {
    const value = await fixture('claude');
    const result = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    expect(text(result, 'skills/alpha/SKILL.md').split('\n---\n')[1]).toBe(
      'Body alpha.\nSee [shared](../shared/GUIDE.md).\n',
    );
  });

  it('fails closed on duplicate final paths', async () => {
    const value = await fixture('claude', { sharedIdentity: true });
    await writeFile(path.join(value.sharedRoot, 'SKILL.md'), '# collision\n');
    await expect(
      compileContent({
        runtime: 'claude',
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      }),
    ).rejects.toThrow(/duplicate output path/u);
  });

  it('fails closed when a required feature is unsupported', async () => {
    const value = await fixture('pi');
    await expect(
      compileContent({
        runtime: 'pi',
        plan: value.plan,
        runtimeProfiles,
        requiredFeatures: ['argument-hint'],
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      }),
    ).rejects.toThrow(/required feature.*argument-hint.*unsupported/iu);
  });

  it('fails closed on unverified plans', async () => {
    const value = await fixture('claude');
    await expect(
      compileContent({
        runtime: 'claude',
        plan: { ...value.plan } as SkillProjectionPlan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      }),
    ).rejects.toThrow(/SKILL_PROJECTION_PLAN_UNVERIFIED/u);
  });

  it('does not truncate a projection body when frontmatter delimiters use mixed newlines', async () => {
    const value = await fixture('claude', { mixedNewlines: true });
    const result = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    expect(text(result, 'skills/alpha/SKILL.md')).toContain(
      'Body alpha.\nSee [shared](../shared/GUIDE.md).\n',
    );
  });

  it('verifies reference-definition links while ignoring external URLs and anchors', async () => {
    const broken = await fixture('claude', {
      referenceDefinition:
        '\n[missing]: references/missing.md\n[web]: https://example.com/a\n[section]: #heading\n',
    });
    await expect(
      compileContent({
        runtime: 'claude',
        plan: broken.plan,
        runtimeProfiles,
        sharedInstructionRoot: broken.sharedRoot,
        agentRoot: broken.agentRoot,
      }),
    ).rejects.toThrow(/unresolved Markdown reference.*missing\.md/u);
  });

  it('records exact hashes and byte counts for every represented file and excludes its envelope', async () => {
    const value = await fixture('claude');
    const result = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    expect(result.manifest.manifestEnvelope).toEqual({
      path: 'active-content.json',
      includedInFileMap: false,
    });
    const represented = result.files.filter((file) => file.relativePath !== 'active-content.json');
    expect(result.manifest.files).toEqual(
      represented.map(({ relativePath, sha256, byteCount }) => ({
        relativePath,
        sha256,
        byteCount,
      })),
    );
    for (const file of represented) {
      expect(file.byteCount).toBe(file.bytes.byteLength);
      expect(file.sha256).toBe(createHash('sha256').update(file.bytes).digest('hex'));
    }
  });

  it('rejects a compiled tree when its generated bytes are mutated after compilation', async () => {
    const value = await fixture('claude');
    const result = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    result.files.find((file) => file.relativePath === 'skills/alpha/SKILL.md')!.bytes[0] = 0;
    expect(() =>
      verifyCompiledContentTree(result, { runtime: 'claude', plan: value.plan }),
    ).toThrow(/COMPILED_CONTENT_TREE_CHANGED/u);
  });

  it('records a UTF-8 byte offset that loads an exact Unicode body with mixed newlines', async () => {
    const value = await fixture('pi', { unicodeBody: true });
    const result = await compileContent({
      runtime: 'pi',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    const skill = result.manifest.skills.find((entry) => entry.identity === 'alpha')!;
    const file = result.files.find((entry) => entry.relativePath === skill.generatedPath)!;
    expect(Buffer.from(file.bytes).subarray(skill.bodyByteOffset).toString('utf8')).toBe(
      'Unicode café 漢字 alpha.\r\nSecond line.\n',
    );
    expect(skill.generatedSha256).toBe(file.sha256);
  });

  it('records no capability grant status for skills that declare no capabilities', async () => {
    const value = await fixture('claude');
    const result = await compileContent({
      runtime: 'claude',
      plan: value.plan,
      runtimeProfiles,
      sharedInstructionRoot: value.sharedRoot,
      agentRoot: value.agentRoot,
    });
    expect(result.manifest.skills.find((entry) => entry.identity === 'named')).not.toHaveProperty(
      'capabilityGrantsApplied',
    );
  });

  it('fails closed on case-only output collisions', async () => {
    const value = await fixture('claude', { sharedIdentity: true });
    await writeFile(path.join(value.sharedRoot, 'skill.md'), '# collision\n');
    await expect(
      compileContent({
        runtime: 'claude',
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      }),
    ).rejects.toThrow(/duplicate output path/u);
  });

  it('fails closed when an emitted relative Markdown reference is missing', async () => {
    const value = await fixture('claude', { missingShared: true });
    await expect(
      compileContent({
        runtime: 'claude',
        plan: value.plan,
        runtimeProfiles,
        sharedInstructionRoot: value.sharedRoot,
        agentRoot: value.agentRoot,
      }),
    ).rejects.toThrow(/unresolved Markdown reference.*GUIDE\.md/u);
  });
});
