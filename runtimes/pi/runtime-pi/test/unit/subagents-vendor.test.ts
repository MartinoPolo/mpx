import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../vendor/subagents');

function unmanifestedProjectedSources(
  projectedPaths: readonly string[],
  manifestedPaths: readonly string[],
): string[] {
  const manifested = new Set(manifestedPaths);
  return projectedPaths
    .filter((relative) => relative.endsWith('.ts') && !manifested.has(relative))
    .sort();
}

async function projectedTypeScriptSources(directory: string, relative = ''): Promise<string[]> {
  const sources = await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        return projectedTypeScriptSources(path.join(directory, entry.name), child);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [child] : [];
    }),
  );
  return sources.flat().sort();
}

describe('subagent vendor provenance', () => {
  it('rejects unmanifested projected TypeScript sources deterministically', () => {
    expect(
      unmanifestedProjectedSources(
        ['z-extra.ts', 'LICENSE', 'nested/covered.ts', 'a-extra.ts'],
        ['nested/covered.ts', 'LICENSE'],
      ),
    ).toEqual(['a-extra.ts', 'z-extra.ts']);
  });

  it('matches the complete pinned SHA-256 manifest without mutable machine roots', async () => {
    const manifest = await readFile(path.join(root, 'SHA256SUMS'), 'utf8');
    const lines = manifest.trim().split(/\r?\n/u);
    const manifestedPaths = lines.map((line) => line.split('  ')[1]).filter(Boolean) as string[];
    expect(
      unmanifestedProjectedSources(await projectedTypeScriptSources(root), manifestedPaths),
    ).toEqual([]);

    for (const line of lines) {
      const [expected, relative] = line.split('  ');
      expect(relative).toBeDefined();
      if (!relative) {
        throw new Error(`invalid SHA-256 manifest line: ${line}`);
      }
      const content = await readFile(path.join(root, relative));
      expect(createHash('sha256').update(content).digest('hex'), relative).toBe(expected);
      expect(content.toString('utf8'), relative).not.toMatch(
        /[A-Za-z]:[\\/]_MP_(?:projects|work|github_cloned|apps)/iu,
      );
    }
  });
  it('keeps nesting authority limited to the two fixer identities', async () => {
    const catalog = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, '../../../../../content/agents/metadata.json'),
        'utf8',
      ),
    ) as { agents: Record<string, { nesting: string[] }> };
    expect(
      Object.entries(catalog.agents)
        .filter(([, metadata]) => metadata.nesting.length > 0)
        .map(([identity]) => identity)
        .sort(),
    ).toEqual(['mpx-check-fixer', 'mpx-ci-fixer']);
  });
  it('retains the vendored nested-agent resolver after compiler ownership moves agent files', async () => {
    expect(await readFile(path.join(root, 'nested-tools.ts'), 'utf8')).toContain(
      'resolveTypeIn(registry, name)',
    );
  });
  it('is projected as reviewed source while activation uses the provider-neutral bridge', async () => {
    const bridgeSource = await readFile(
      path.resolve(import.meta.dirname, '../../src/subagent-bridge.ts'),
      'utf8',
    );
    expect(bridgeSource).toMatch(/from ['"]@mpx\/subagents['"]/u);
    expect(await readdir(root)).toContain('LICENSE');
  });
});
