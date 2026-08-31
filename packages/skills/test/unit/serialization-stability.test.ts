import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createRuntimeSkillArtifact,
  humanListSkills,
  humanSearchSkills,
  humanSkillDetail,
  initialModelContext,
  loadSkillBody,
  resolveManifest,
  type CanonicalSkill,
  type ProjectSkill,
  type ResolveOptions,
} from '../../src/index.js';

const canonical: CanonicalSkill = {
  identity: 'alpha',
  description: 'Alpha portable description',
  triggers: 'alpha trigger',
  skillPacks: ['work', 'core'],
  defaultExposure: 'full',
  sourcePath: '/catalog/alpha/SKILL.md',
  realPath: '/catalog/alpha/SKILL.md',
  contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const project: ProjectSkill = {
  identity: 'deploy',
  description: 'Deploy portable project',
  projectExposure: 'explicit-only',
  disableModelInvocation: true,
  sourcePath: '/project/.agents/skills/deploy/SKILL.md',
  realPath: '/project/.agents/skills/deploy/SKILL.md',
  contentHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  directoryHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  projectRoot: '/project',
  realProjectRoot: '/project',
};
const options: ResolveOptions = {
  repositoryId: 'portable/repository',
  projectId: 'portable/project',
  contentScope: 'portable-scope',
  enabledPacks: ['work', 'core'],
  identity: 'portable-identity',
  skillPolicy: 'portable-policy',
  skillPolicyConfig: { skillExposure: { default: 'full' } },
  mapping: { alpha: '/custom:alpha' },
};

it('keeps resolved manifest JSON bytes and keys stable', () => {
  const manifest = resolveManifest([project, canonical], options);
  expect(JSON.stringify(manifest)).toBe(
    '{"schemaVersion":4,"binding":{"projectId":"portable/project","repositoryId":"portable/repository","contentScope":"portable-scope"},"decisions":[{"identity":"alpha","included":true,"exclusionReasons":[],"exposure":"full","permissions":{"humanInvocation":true,"modelInvocation":true},"metadataHash":"49bcbfbecc9f18639df4ce4e88ab7608baf369e37808f1e5fbf3c940aeacba12","sourceHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"identity":"deploy","included":true,"exclusionReasons":[],"exposure":"explicit-only","permissions":{"humanInvocation":true,"modelInvocation":false},"metadataHash":"fb7df916c3a810bbc860d6e8acbeb12bf65f5eb9109c1728614676b052eb3f38","sourceHash":"17c89c3433ec8aa4fb6575f4eb229294a917ff9b4ac2be87a68f0478979d5ef8"}],"manifestKey":"e777c180eda6e46b261e99fbeb0602b9cd10eb5cb9f167f2f52aee44500acbfb"}',
  );
});

it('keeps runtime artifact and reference JSON bytes and hashes stable', () => {
  const manifest = resolveManifest([project, canonical], options);
  const artifact = createRuntimeSkillArtifact(manifest, [project, canonical], {
    runtime: 'pi',
    mapping: options.mapping,
  });
  expect(JSON.stringify({ artifact, reference: artifact.reference })).toBe(
    '{"artifact":{"schemaVersion":4,"runtime":"pi","manifestKey":"e777c180eda6e46b261e99fbeb0602b9cd10eb5cb9f167f2f52aee44500acbfb","reference":{"schemaVersion":4,"runtime":"pi","manifestKey":"e777c180eda6e46b261e99fbeb0602b9cd10eb5cb9f167f2f52aee44500acbfb","artifactKey":"f9e521e5ba93844086732c3317dc121c622e7e10c91c2f06bf6202d8b6f29b24","fileMapHash":"1970220bc1485faf62a6c8530fba10c5292ab3350f47bed60412423324fbc86b"},"entries":[{"identity":"alpha","publicName":"/custom:alpha","packs":["core","work"],"exposure":"full","metadataHash":"49bcbfbecc9f18639df4ce4e88ab7608baf369e37808f1e5fbf3c940aeacba12","description":"Alpha portable description","triggers":"alpha trigger","source":{"kind":"canonical","path":"/catalog/alpha/SKILL.md","realPath":"/catalog/alpha/SKILL.md","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"permissions":{"humanInvocation":true,"modelInvocation":true}},{"identity":"deploy","publicName":"/deploy","packs":[],"exposure":"explicit-only","metadataHash":"fb7df916c3a810bbc860d6e8acbeb12bf65f5eb9109c1728614676b052eb3f38","source":{"kind":"project","path":"/project/.agents/skills/deploy/SKILL.md","realPath":"/project/.agents/skills/deploy/SKILL.md","contentHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","directoryHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","projectRoot":"/project","realProjectRoot":"/project"},"permissions":{"humanInvocation":true,"modelInvocation":false}}]},"reference":{"schemaVersion":4,"runtime":"pi","manifestKey":"e777c180eda6e46b261e99fbeb0602b9cd10eb5cb9f167f2f52aee44500acbfb","artifactKey":"f9e521e5ba93844086732c3317dc121c622e7e10c91c2f06bf6202d8b6f29b24","fileMapHash":"1970220bc1485faf62a6c8530fba10c5292ab3350f47bed60412423324fbc86b"}}',
  );
});

it('keeps projection, search, detail, and context JSON bytes stable', () => {
  const catalog = [project, canonical];
  const manifest = resolveManifest(catalog, options);
  const artifact = createRuntimeSkillArtifact(manifest, catalog, {
    runtime: 'pi',
    mapping: options.mapping,
  });
  expect(
    JSON.stringify({
      projection: humanListSkills(artifact),
      search: humanSearchSkills(artifact, catalog, 'portable'),
      detail: humanSkillDetail(artifact, catalog, 'deploy'),
      context: initialModelContext(artifact),
    }),
  ).toBe(
    '{"projection":[{"identity":"alpha","publicName":"/custom:alpha"},{"identity":"deploy","publicName":"/deploy"}],"search":[{"identity":"alpha","publicName":"/custom:alpha","description":"Alpha portable description","score":1},{"identity":"deploy","publicName":"/deploy","description":"Deploy portable project","score":1}],"detail":{"identity":"deploy","publicName":"/deploy","description":"Deploy portable project"},"context":[{"identity":"alpha","publicName":"/custom:alpha","description":"Alpha portable description","triggers":"alpha trigger"}]}',
  );
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('keeps the loader wrapper bytes stable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-byte-loader-'));
  temporaryRoots.push(root);
  const skillRoot = path.join(root, 'alpha');
  const sourcePath = path.join(skillRoot, 'SKILL.md');
  const text =
    '---\nname: alpha\ndescription: Alpha portable description\ntriggers: alpha trigger\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: full\n---\nPORTABLE BODY\n';
  await mkdir(skillRoot);
  await writeFile(sourcePath, text);
  const { createHash } = await import('node:crypto');
  const loaderCatalog: CanonicalSkill[] = [
    {
      ...canonical,
      skillPacks: ['core'],
      sourcePath,
      realPath: sourcePath,
      contentHash: createHash('sha256').update(text).digest('hex'),
    },
  ];
  const manifest = resolveManifest(loaderCatalog, { ...options, enabledPacks: ['core'] });
  const artifact = createRuntimeSkillArtifact(manifest, loaderCatalog, { runtime: 'pi' });
  const loaded = await loadSkillBody({
    canonicalRoot: root,
    manifest,
    artifact,
    runtime: 'pi',
    identity: 'alpha',
    invocation: 'model',
  });
  expect(JSON.stringify({ body: loaded.body, wrappedBody: loaded.wrappedBody })).toBe(
    JSON.stringify({
      body: 'PORTABLE BODY\n',
      wrappedBody: `<!-- mpx-skill identity=alpha origin=model runtime=pi artifact=${artifact.reference.artifactKey} hash=${loaderCatalog[0]!.contentHash} -->
PORTABLE BODY
<!-- /mpx-skill -->`,
    }),
  );
});
