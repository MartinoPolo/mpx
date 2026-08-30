import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectInventory } from '../../../scripts/native-capability-inventory.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-native-inventory-'));
  const claude = path.join(root, 'claude-personal');
  const pi = path.join(root, 'pi-personal');
  await mkdir(path.join(claude, 'plugins', 'cache', 'mpx'), { recursive: true });
  await writeFile(
    path.join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'mpx@local': [
          {
            scope: 'project',
            installPath: path.join(claude, 'plugins', 'cache', 'mpx'),
            version: 'build-ref-123',
            installedAt: 'SANITIZED',
            lastUpdated: 'SANITIZED',
            gitCommitSha: 'abc123',
            projectPath: 'SANITIZED',
          },
        ],
      },
    }),
  );
  await writeFile(
    path.join(claude, 'plugins', 'cache', 'mpx', 'plugin.json'),
    JSON.stringify({
      name: 'mpx',
      description: 'Sanitized fixture',
      author: { name: 'Example', email: 'example.invalid' },
      commands: ['commands/review.md'],
      agents: ['agents/checker.md'],
    }),
  );
  await mkdir(path.join(pi, 'node_modules', '@mpx', 'runtime-pi'), { recursive: true });
  await writeFile(
    path.join(pi, 'package.json'),
    JSON.stringify({
      name: 'pi-extensions',
      private: true,
      dependencies: { '@mpx/runtime-pi': '^1.2.3' },
    }),
  );
  await writeFile(
    path.join(pi, 'node_modules', '@mpx', 'runtime-pi', 'package.json'),
    JSON.stringify({
      name: '@mpx/runtime-pi',
      version: '1.2.3',
      description: 'Sanitized fixture',
      author: 'Example',
      type: 'module',
      exports: { '.': './index.ts' },
      files: ['index.ts'],
      license: 'MIT',
      repository: { type: 'git', url: 'https://example.invalid/repository' },
      scripts: { test: 'sanitized' },
      peerDependencies: { 'example-peer': '^1.0.0' },
      peerDependenciesMeta: { 'example-peer': { optional: true } },
      publishConfig: { access: 'public' },
      pi: {
        image: 'https://example.invalid/image.png',
        extensions: ['./index.ts'],
        skills: ['./skills'],
      },
    }),
  );
  return { root, claude, pi };
}

describe('privacy-safe native capability inventory', () => {
  it('projects only package identity, exact version, named routes, redacted source, and comparison', async () => {
    const f = await fixture();
    try {
      const result = await collectInventory({
        roots: [
          { identity: 'personal', runtime: 'claude', path: f.claude },
          { identity: 'personal', runtime: 'pi', path: f.pi },
        ],
        declarations: [
          {
            runtime: 'claude',
            id: 'mpx@local',
            version: 'build-ref-123',
            capabilityRoutes: ['agent:checker', 'command:review'],
          },
          {
            runtime: 'pi',
            id: '@mpx/runtime-pi',
            version: '1.2.3',
            capabilityRoutes: ['extension:index', 'skill:skills'],
          },
        ],
      });
      expect(result.entries).toEqual([
        {
          identity: 'personal',
          runtime: 'claude',
          id: 'mpx@local',
          version: 'build-ref-123',
          capabilityRoutes: ['agent:checker', 'command:review'],
          source: '${personal.claude}/plugins/cache/mpx/plugin.json',
          classification: 'matched',
        },
        {
          identity: 'personal',
          runtime: 'pi',
          id: '@mpx/runtime-pi',
          version: '1.2.3',
          capabilityRoutes: ['extension:index', 'skill:skills'],
          source: '${personal.pi}/node_modules/@mpx/runtime-pi/package.json',
          classification: 'matched',
        },
      ]);
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(result.roots[0].digest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('classifies missing, extra, and version/route mismatches without copying state', async () => {
    const f = await fixture();
    try {
      const result = await collectInventory({
        roots: [
          { identity: 'personal', runtime: 'claude', path: f.claude },
          { identity: 'personal', runtime: 'pi', path: f.pi },
        ],
        declarations: [
          { runtime: 'claude', id: 'mpx@local', version: '9.9.9', capabilityRoutes: [] },
          { runtime: 'pi', id: 'not-installed', version: '1.0.0', capabilityRoutes: [] },
        ],
      });
      expect(result.summary).toEqual({ matched: 0, missing: 1, extra: 1, unsupported: 1 });
      expect(result.entries.map((entry) => entry.classification).sort()).toEqual([
        'extra',
        'missing',
        'unsupported',
      ]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('classifies an indexed Claude plugin with no exact manifest as unsupported', async () => {
    const f = await fixture();
    try {
      await rm(path.join(f.claude, 'plugins', 'cache', 'mpx', 'plugin.json'));
      const result = await collectInventory({
        roots: [{ identity: 'personal', runtime: 'claude', path: f.claude }],
        declarations: [],
      });
      expect(result.entries).toEqual([
        {
          identity: 'personal',
          runtime: 'claude',
          id: 'mpx@local',
          version: 'build-ref-123',
          capabilityRoutes: [],
          source: '${personal.claude}/plugins/installed_plugins.json',
          classification: 'unsupported',
          reason: 'METADATA_UNAVAILABLE',
        },
      ]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('attaches a reviewed disposition, phase, rationale, and MPX route to observed and expected packages', async () => {
    const f = await fixture();
    try {
      const review = {
        disposition: 'preserve-external',
        phase: 'Phase F1',
        rationale: 'Keep the native provider integration.',
        intendedMpxRoute: 'runtime-native:mpx',
      };
      const expected = {
        disposition: 'expected-after-install',
        phase: 'Phase I',
        rationale: 'Installed only by the MPX installer.',
        intendedMpxRoute: 'runtime-pi:mpx',
      };
      const result = await collectInventory({
        roots: [{ identity: 'personal', runtime: 'claude', path: f.claude }],
        declarations: [
          {
            runtime: 'pi',
            id: '@mpx/runtime-pi',
            version: '0.0.0',
            capabilityRoutes: ['extension:mpx'],
            ...expected,
          },
        ],
        reviews: [{ runtime: 'claude', id: 'mpx@local', ...review }],
      });
      expect(
        result.entries.map(
          ({ id, classification, disposition, phase, rationale, intendedMpxRoute }) => ({
            id,
            classification,
            disposition,
            phase,
            rationale,
            intendedMpxRoute,
          }),
        ),
      ).toEqual([
        { id: '@mpx/runtime-pi', classification: 'missing', ...expected },
        { id: 'mpx@local', classification: 'extra', ...review },
      ]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated native index entries deterministically', async () => {
    const f = await fixture();
    try {
      const indexFile = path.join(f.claude, 'plugins', 'installed_plugins.json');
      const index = JSON.parse(
        await (await import('node:fs/promises')).readFile(indexFile, 'utf8'),
      );
      index.plugins['mpx@local'].push({ ...index.plugins['mpx@local'][0] });
      await writeFile(indexFile, JSON.stringify(index));
      const result = await collectInventory({
        roots: [{ identity: 'personal', runtime: 'claude', path: f.claude }],
        declarations: [],
      });
      expect(result.entries).toHaveLength(1);
      expect(result.summary.extra).toBe(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('rejects a symlink in an allowlisted metadata path', async () => {
    const f = await fixture();
    try {
      const target = path.join(f.root, 'outside.json');
      await writeFile(
        target,
        JSON.stringify({ name: '@mpx/runtime-pi', version: '1.2.3', pi: {} }),
      );
      await rm(path.join(f.pi, 'node_modules', '@mpx', 'runtime-pi', 'package.json'));
      await symlink(target, path.join(f.pi, 'node_modules', '@mpx', 'runtime-pi', 'package.json'));
      await expect(
        collectInventory({
          roots: [{ identity: 'personal', runtime: 'pi', path: f.pi }],
          declarations: [],
        }),
      ).rejects.toThrow(/SYMLINK_REJECTED/u);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('rejects an indexed Claude manifest path outside its designated root', async () => {
    const f = await fixture();
    try {
      await writeFile(
        path.join(f.claude, 'plugins', 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: { 'escape@local': [{ scope: 'user', installPath: f.root, version: '1.0.0' }] },
        }),
      );
      await expect(
        collectInventory({
          roots: [{ identity: 'personal', runtime: 'claude', path: f.claude }],
          declarations: [],
        }),
      ).rejects.toThrow(/PATH_ESCAPE/u);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('rejects unknown root package fields rather than inspecting arbitrary npm settings', async () => {
    const f = await fixture();
    try {
      await writeFile(
        path.join(f.pi, 'package.json'),
        JSON.stringify({
          name: 'pi-extensions',
          private: true,
          dependencies: {},
          settings: { arbitrary: 'redacted' },
        }),
      );
      await expect(
        collectInventory({
          roots: [{ identity: 'personal', runtime: 'pi', path: f.pi }],
          declarations: [],
        }),
      ).rejects.toThrow(/UNKNOWN_SCHEMA/u);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('rejects unknown Pi inventory metadata fields in dependency manifests', async () => {
    const f = await fixture();
    try {
      const manifestFile = path.join(f.pi, 'node_modules', '@mpx', 'runtime-pi', 'package.json');
      const manifest = JSON.parse(
        await (await import('node:fs/promises')).readFile(manifestFile, 'utf8'),
      );
      manifest.pi.account = 'redacted';
      await writeFile(manifestFile, JSON.stringify(manifest));
      await expect(
        collectInventory({
          roots: [{ identity: 'personal', runtime: 'pi', path: f.pi }],
          declarations: [],
        }),
      ).rejects.toThrow(/UNKNOWN_SCHEMA/u);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
