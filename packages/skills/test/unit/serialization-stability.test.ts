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
  schemaVersion: 1,
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
    '{"schemaVersion":4,"binding":{"projectId":"portable/project","repositoryId":"portable/repository","contentScope":"portable-scope"},"decisions":[{"identity":"alpha","included":true,"exclusionReasons":[],"exposure":"full","permissions":{"humanInvocation":true,"modelInvocation":true},"metadataHash":"49bcbfbecc9f18639df4ce4e88ab7608baf369e37808f1e5fbf3c940aeacba12","sourceHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"identity":"skill:deploy","included":true,"exclusionReasons":[],"exposure":"explicit-only","permissions":{"humanInvocation":true,"modelInvocation":false},"metadataHash":"a32eaacab27283238d6e7a88542780627c4f351682cd7ae752ec65daea441e12","sourceHash":"17c89c3433ec8aa4fb6575f4eb229294a917ff9b4ac2be87a68f0478979d5ef8"}],"manifestKey":"8493d41e8b8a245e739c395c1d5b8ea2eb69d095f2bf6f55f1fa9098745d42cf"}',
  );
});

it('keeps runtime artifact and reference JSON bytes and hashes stable', () => {
  const manifest = resolveManifest([project, canonical], options);
  const artifact = createRuntimeSkillArtifact(manifest, [project, canonical], {
    runtime: 'pi',
    mapping: options.mapping,
  });
  expect(JSON.stringify({ artifact, reference: artifact.reference })).toBe(
    '{"artifact":{"schemaVersion":4,"runtime":"pi","manifestKey":"8493d41e8b8a245e739c395c1d5b8ea2eb69d095f2bf6f55f1fa9098745d42cf","reference":{"schemaVersion":4,"runtime":"pi","manifestKey":"8493d41e8b8a245e739c395c1d5b8ea2eb69d095f2bf6f55f1fa9098745d42cf","artifactKey":"0340f6b9695dd12c2c7b9fb32bb81beba24863d12c9f505290a96d2e8451cf02","fileMapHash":"f662a3422108e59e282727d355eff377b9703edb8eb74640dc8400e25a84814b"},"entries":[{"identity":"alpha","publicName":"/custom:alpha","packs":["core","work"],"exposure":"full","metadataHash":"49bcbfbecc9f18639df4ce4e88ab7608baf369e37808f1e5fbf3c940aeacba12","description":"Alpha portable description","triggers":"alpha trigger","source":{"kind":"canonical","path":"/catalog/alpha/SKILL.md","realPath":"/catalog/alpha/SKILL.md","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"permissions":{"humanInvocation":true,"modelInvocation":true}},{"identity":"skill:deploy","publicName":"/skill:deploy","packs":[],"exposure":"explicit-only","metadataHash":"a32eaacab27283238d6e7a88542780627c4f351682cd7ae752ec65daea441e12","source":{"kind":"project","path":"/project/.agents/skills/deploy/SKILL.md","realPath":"/project/.agents/skills/deploy/SKILL.md","contentHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","directoryHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","projectRoot":"/project","realProjectRoot":"/project"},"permissions":{"humanInvocation":true,"modelInvocation":false}}]},"reference":{"schemaVersion":4,"runtime":"pi","manifestKey":"8493d41e8b8a245e739c395c1d5b8ea2eb69d095f2bf6f55f1fa9098745d42cf","artifactKey":"0340f6b9695dd12c2c7b9fb32bb81beba24863d12c9f505290a96d2e8451cf02","fileMapHash":"f662a3422108e59e282727d355eff377b9703edb8eb74640dc8400e25a84814b"}}',
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
      detail: humanSkillDetail(artifact, catalog, 'skill:deploy'),
      context: initialModelContext(artifact),
    }),
  ).toBe(
    '{"projection":[{"identity":"alpha","publicName":"/custom:alpha"},{"identity":"skill:deploy","publicName":"/skill:deploy"}],"search":[{"identity":"alpha","publicName":"/custom:alpha","description":"Alpha portable description","score":1},{"identity":"skill:deploy","publicName":"/skill:deploy","description":"Deploy portable project","score":1}],"detail":{"identity":"skill:deploy","publicName":"/skill:deploy","description":"Deploy portable project"},"context":[{"identity":"alpha","publicName":"/custom:alpha","description":"Alpha portable description","triggers":"alpha trigger"}]}',
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
    '---\nname: alpha\ndescription: Alpha portable description\ntriggers: alpha trigger\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n---\nPORTABLE BODY\n';
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
