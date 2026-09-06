import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inventoryCanonical,
  inventoryProjectSkills,
  MAX_PROJECT_SKILL_INVENTORY_BYTES,
  MAX_SKILL_DIRECTORY_BYTES,
  type ProjectSkillFileSystem,
} from '../../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-project-boundary-'));
  roots.push(root);
  return root;
}

async function skill(root: string, name: string, header: string): Promise<string> {
  const directory = path.join(root, '.agents', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\n${header}\n---\nNative body.\n`);
  return directory;
}

const ordinaryHeader = `name: native-skill
description: 'Use when: "native skill", keep ordinary punctuation.'
allowed-tools: Read, Write, Bash(pnpm ingest:gifts *)
metadata:
    author: Someone
    version: '1.0'
    category: operations`;

const managedHeader = `name: managed-skill
description: Managed guidance
metadata:
  mpx:
    projectExposure: full`;

describe('native versus managed project skills', () => {
  it.each([
    'name: native-skill\ndescription: Native guidance',
    ordinaryHeader,
    'name: native-skill\ndescription: Native\n"metadata":\n    \'author\': Someone',
    'name: native-skill\ndescription: |\n    metadata:\n        mpx: null\nallowed-tools: |\n    Read\n    Bash(pnpm *)',
    'name: native-skill\ndescription: Native\n# metadata:\n#   mpx: null\nmetadata: # ordinary mapping\n    note: "mpx: not a key"',
    'name: native-skill\ndescription: Native\nmetadata:\n    note: |\n        mpx: null\n    owner: Someone',
    'name: native-skill\ndescription: Native\nmetadata: {owner: Someone, nested: {mpx: null}}',
    'name: native-skill\nmetadata: {owner: Someone} # ordinary\ndescription: Native\nallowed-tools: Read, Write',
    'name: native-skill\ndescription: Native\nmetadata: {\n    "owner": "Someone", # mpx: null\n    category: ordinary\n}',
    'name: DIFFERENT_native_name\ndescription: Native\ndisable-model-invocation: true',
    '    name: native-skill\n    description: Native\n    metadata:\n        author: Someone',
  ])('keeps native metadata outside canonical validation: %s', async (header) => {
    const root = await project();
    const directory = await skill(root, 'native-skill', header);
    const result = await inventoryProjectSkills(root);
    expect(result).toEqual({ skills: [], nativeSkillDirectories: [directory], diagnostics: [] });
  });

  it('keeps native identities outside canonical namespace collision checks', async () => {
    const root = await project();
    const canonicalRoot = path.join(root, 'canonical');
    await mkdir(path.join(canonicalRoot, 'review'), { recursive: true });
    await writeFile(
      path.join(canonicalRoot, 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Canonical\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n---\n',
    );
    const directory = await skill(root, 'review', 'name: review\ndescription: Native review');
    const prefixed = await skill(root, 'mpx-local', 'name: mpx-local\ndescription: Native prefix');
    const result = await inventoryProjectSkills(root, await inventoryCanonical(canonicalRoot));
    expect(result.skills).toEqual([]);
    expect(result.nativeSkillDirectories).toEqual([prefixed, directory]);
    expect(result.diagnostics).toEqual([]);
  });

  it.each(['full', 'explicit-only'] as const)(
    'retains strict %s managed exposure and hashes',
    async (exposure) => {
      const root = await project();
      await skill(
        root,
        'managed-skill',
        managedHeader.replace('full', exposure) +
          (exposure === 'explicit-only' ? '\ndisable-model-invocation: true' : ''),
      );
      const result = await inventoryProjectSkills(root);
      expect(result.nativeSkillDirectories).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.skills).toEqual([
        expect.objectContaining({
          identity: 'managed-skill',
          projectExposure: exposure,
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          directoryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]);
    },
  );

  it.each([
    'metadata:\n  mpx: null',
    'metadata:\n  mpx:',
    'metadata:\n  "mpx": null',
    '"metadata":\n  mpx:\n    projectExposure: full',
    '"metad\\u0061ta":\n  "m\\u0070x": null',
    'metadata: {mpx: null}',
    'metadata: {"mpx": {projectExposure: full}}',
    'metadata: {owner: Someone,\n  "mpx": null}',
    'metadata:\n  owner: Someone\n  mpx: null\n  mpx:\n    projectExposure: full',
    'metadata:\n  owner: Someone\n    mpx: null',
    'metadata: {owner: Someone mpx: null}',
    'metadata: {owner: Someone}\nmetadata:\n  mpx: null',
    'metadata:\n  owner: Someone\nmetadata:\n  mpx:\n    projectExposure: full',
    'metadata:\n    mpx:\n        projectExposure: full',
    'metadata:\n  mpx:\n    projectExposure: off',
    'metadata:\n  mpx:\n    projectExposure: explicit-only',
    'metadata: *inherited',
    '<<: *inherited',
    'metadata:\n  <<: *inherited',
    'metadata: scalar\n  mpx: null',
    '  metadata:\n    mpx: null',
    'metadata:\n\tmpx: null',
  ])('never falls back to native for explicit or ambiguous ownership: %s', async (metadata) => {
    const root = await project();
    await skill(root, 'managed-skill', `name: managed-skill\ndescription: Managed\n${metadata}`);
    const result = await inventoryProjectSkills(root);
    expect(result.skills).toEqual([]);
    expect(result.nativeSkillDirectories).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'PROJECT_SKILL_INVALID' }),
    ]);
  });

  it('classifies ownership before reading directory support files', async () => {
    const enumerateDirectory = vi.fn();
    const filesystem: ProjectSkillFileSystem = {
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { name: 'native', isDirectory: () => true };
        },
      }),
      realpath: async (file) => file,
      readFile: async () => '---\nmetadata: *ambiguous\n---\n',
      enumerateDirectory,
    };
    const result = await inventoryProjectSkills('C:/repo', [], filesystem);
    expect(result.nativeSkillDirectories).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(enumerateDirectory).not.toHaveBeenCalled();
  });

  it('bounds ownership frontmatter before support-file snapshots', async () => {
    const root = await project();
    await skill(root, 'native-skill', `name: native-skill\ndescription: ${'x'.repeat(64 * 1024)}`);
    const result = await inventoryProjectSkills(root);
    expect(result.nativeSkillDirectories).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain('ownership is ambiguous');
  });

  it('rejects a SKILL.md that changes from native to managed during containment inspection', async () => {
    const filesystem: ProjectSkillFileSystem = {
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { name: 'native', isDirectory: () => true };
        },
      }),
      realpath: async (file) => file,
      readFile: async () => `---\n${ordinaryHeader}\n---\n`,
      enumerateDirectory: async () => [
        { relativePath: 'SKILL.md', bytes: Buffer.from(`---\n${managedHeader}\n---\n`) },
      ],
    };
    const result = await inventoryProjectSkills('C:/repo', [], filesystem);
    expect(result.nativeSkillDirectories).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain('changed after ownership classification');
  });

  it.each(['directory', 'entrypoint', 'support', 'sibling-entrypoint'] as const)(
    'rejects native %s links',
    async (kind) => {
      const root = await project();
      const directory = await skill(root, 'native-skill', ordinaryHeader);
      const target = path.join(root, 'target');
      if (kind === 'directory') {
        await mkdir(target);
        await symlink(target, path.join(root, '.agents', 'skills', 'linked'), 'junction');
      } else {
        await writeFile(target, 'outside');
        const link =
          kind === 'entrypoint' || kind === 'sibling-entrypoint'
            ? path.join(directory, 'SKILL.md')
            : path.join(directory, 'support.txt');
        await rm(link, { force: true });
        const destination =
          kind === 'sibling-entrypoint'
            ? path.join(await skill(root, 'sibling', ordinaryHeader), 'SKILL.md')
            : target;
        await symlink(destination, link, 'file');
      }
      const result = await inventoryProjectSkills(root);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'PROJECT_SKILL_INVALID' }),
      ]);
      if (kind !== 'directory') {
        expect(result.nativeSkillDirectories).not.toContain(directory);
      }
    },
  );

  it('rejects a linked inventory root rather than importing external native skills', async () => {
    const root = await project();
    const outside = await project();
    await mkdir(path.join(root, '.agents'));
    await symlink(outside, path.join(root, '.agents', 'skills'), 'junction');
    await expect(inventoryProjectSkills(root)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'PROJECT_SKILL_INVENTORY_FAILED' })],
    });
  });

  it('bounds native support files without accepting an oversized native directory', async () => {
    const root = await project();
    const directory = await skill(root, 'native-skill', ordinaryHeader);
    await writeFile(path.join(directory, 'support'), Buffer.alloc(MAX_SKILL_DIRECTORY_BYTES + 1));
    const result = await inventoryProjectSkills(root);
    expect(result.nativeSkillDirectories).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain('byte limit');
  });

  it('retains byte charges when a native directory fails partway through inspection', async () => {
    const header = `---\n${ordinaryHeader}\n---\n`;
    const filesystem: ProjectSkillFileSystem = {
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 10; index += 1) {
            yield { name: `native-${index}`, isDirectory: () => true };
          }
        },
      }),
      realpath: async (file) => file,
      readFile: async () => header,
      enumerateDirectory: async (_directory, remaining, onFileBytes) => {
        if (remaining < MAX_SKILL_DIRECTORY_BYTES) {
          return [{ relativePath: 'SKILL.md', bytes: Buffer.alloc(MAX_SKILL_DIRECTORY_BYTES) }];
        }
        onFileBytes?.('support', MAX_SKILL_DIRECTORY_BYTES - Buffer.byteLength(header));
        throw new Error('support file changed while reading');
      },
    };
    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'PROJECT_SKILL_INVENTORY_LIMIT' })],
    });
  });

  it('charges native and rejected classification bytes against the total inventory budget', async () => {
    const nativeText = `---\n${ordinaryHeader}\n---\n`;
    const bytes = Buffer.alloc(MAX_SKILL_DIRECTORY_BYTES, 'x');
    Buffer.from(nativeText).copy(bytes);
    const readFile = vi.fn(async () => bytes.toString('utf8'));
    const filesystem: ProjectSkillFileSystem = {
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 10; index += 1) {
            yield { name: `native-${index}`, isDirectory: () => true };
          }
        },
      }),
      realpath: async (file) => file,
      readFile,
    };
    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'PROJECT_SKILL_INVENTORY_LIMIT' })],
    });
    expect(readFile).toHaveBeenCalledTimes(MAX_PROJECT_SKILL_INVENTORY_BYTES / bytes.length + 1);
    bytes.fill('x');
    readFile.mockClear();
    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'PROJECT_SKILL_INVENTORY_LIMIT' })],
    });
    expect(readFile).toHaveBeenCalledTimes(MAX_PROJECT_SKILL_INVENTORY_BYTES / bytes.length + 1);
  });
});
