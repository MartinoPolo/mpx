import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../vendor/subagents');

describe('subagent vendor provenance', () => {
  it('matches the pinned SHA-256 manifest without mutable machine roots', async () => {
    const manifest = await readFile(path.join(root, 'SHA256SUMS'), 'utf8');
    for (const line of manifest.trim().split(/\r?\n/u)) {
      const [expected, relative] = line.split('  ');
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
        path.resolve(import.meta.dirname, '../../../../content/agents/metadata.json'),
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
  it('projects every approved check-fixer reviewer as an exact runtime identity', async () => {
    const projection = path.resolve(import.meta.dirname, '../projection/agents'),
      names = await readdir(projection);
    const identities = new Set(names.map((name) => name.slice(0, -3)));
    const fixer = await readFile(path.join(projection, 'mpx-check-fixer.md'), 'utf8');
    const allowed = fixer.match(/^allowed_subagents: (.+)$/mu)?.[1]?.split(',') ?? [];
    expect(allowed).toEqual(
      expect.arrayContaining(['mpx-reviewer-security', 'mpx-reviewer-test-quality']),
    );
    expect(allowed.every((identity) => !identity.includes('*') && identities.has(identity))).toBe(
      true,
    );
    expect(await readFile(path.join(root, 'nested-tools.ts'), 'utf8')).toContain(
      'resolveTypeIn(registry, name)',
    );
  });
  it('is projected as reviewed source while activation uses the provider-neutral bridge', async () => {
    const bridgeSource = await readFile(
      path.resolve(import.meta.dirname, '../src/subagent-bridge.ts'),
      'utf8',
    );
    expect(bridgeSource).toMatch(/from ['"]@mpx\/subagents['"]/u);
    expect(await readdir(root)).toContain('LICENSE');
  });
});
