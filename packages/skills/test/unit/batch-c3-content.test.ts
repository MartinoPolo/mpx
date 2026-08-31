import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { inventoryCanonical } from '../../src/index.js';
import semanticFixture from '../fixtures/batch-c3-semantic.json' with { type: 'json' };

const root = path.resolve(import.meta.dirname, '../../../../content/skills');
const instructions = path.resolve(import.meta.dirname, '../../../../content/instructions');
const identities = Object.keys(semanticFixture.skills);

async function files(identity: string): Promise<string[]> {
  const directory = path.join(root, identity);
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function skill(identity: string): Promise<string> {
  return readFile(path.join(root, identity, 'SKILL.md'), 'utf8');
}

describe('Batch C3 canonical content', () => {
  it('enforces the semantic content contract and records a version for every imported skill', async () => {
    expect(identities).toHaveLength(28);
    for (const [identity, fixture] of Object.entries(semanticFixture.skills)) {
      expect(fixture.version, `${identity} version`).toMatch(/^\d+\.\d+(?:\.\d+)?$/u);
      const content = await skill(identity);
      for (const snippet of fixture.required) {
        expect(content, `${identity}: ${snippet}`).toContain(snippet);
      }
    }
  });

  it('keeps Batch C3 frontmatter normalized and catalogued with the intended policies', async () => {
    const catalog = new Map(
      (await inventoryCanonical(root)).map((entry) => [entry.identity, entry]),
    );
    for (const identity of identities) {
      const entry = catalog.get(identity);
      expect(entry, identity).toBeDefined();
      expect(entry!.skillPacks).toEqual(identity === 'review' ? ['core'] : ['work']);
      expect(entry!.defaultExposure).toBe(
        identity === 'review'
          ? 'full'
          : ['agent-create', 'grill-voice', 'mockup', 'playwright-test'].includes(identity)
            ? 'explicit-only'
            : 'name-only',
      );
    }
  });

  it("restores NotebookLM's complete support-document set", async () => {
    expect((await readdir(path.join(root, 'notebooklm'))).sort()).toEqual([
      'ARTIFACTS.md',
      'COMMANDS.md',
      'SKILL.md',
      'TROUBLESHOOTING.md',
      'WORKFLOWS.md',
    ]);
  });

  it('retains every imported and co-located Batch C3 support asset', async () => {
    const missing: string[] = [];
    for (const [identity, references] of Object.entries(semanticFixture.supportFiles)) {
      for (const reference of references) {
        try {
          await stat(path.join(root, identity, reference));
        } catch {
          missing.push(`${identity}/${reference}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps every Batch C3 JavaScript support script syntactically valid', () => {
    for (const [identity, references] of Object.entries(semanticFixture.supportFiles)) {
      for (const reference of references) {
        if (!/\.(?:m?js)$/u.test(reference)) {
          continue;
        }
        const result = spawnSync(
          process.execPath,
          ['--check', path.join(root, identity, reference)],
          { encoding: 'utf8' },
        );
        expect(result.status, `${identity}/${reference}: ${result.stderr}`).toBe(0);
      }
    }
  });

  it('closes every relative Markdown support-file reference', async () => {
    const missing: string[] = [];
    for (const identity of identities) {
      for (const file of await files(identity)) {
        if (!file.endsWith('.md')) {
          continue;
        }
        const content = await readFile(file, 'utf8');
        for (const match of content.matchAll(/\[[^\]]*\]\((?!https?:|#)([^)#]+)(?:#[^)]+)?\)/gu)) {
          const reference = match[1];
          if (!reference) {
            continue;
          }
          const candidate = reference.startsWith('../shared/')
            ? path.join(instructions, reference.slice(3))
            : path.resolve(path.dirname(file), reference);
          try {
            await stat(candidate);
          } catch {
            missing.push(`${path.relative(root, file)} -> ${reference}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('contains no legacy checkout tokens, runtime placeholders, provider CLIs, or provider command identities', async () => {
    const violations: string[] = [];
    const forbidden: Array<[string, RegExp]> = [
      ['checkout token', /\$\{CLAUDE_(?:SKILL_DIR|PLUGIN_ROOT)\}/u],
      ['runtime placeholder', /\$ARGUMENTS|\{\{(?:[A-Z_][A-Z0-9_]*|[^}]*<[^}]*)\}\}/u],
      ['provider CLI', /(?:^|[\n`$;|&])\s*(?:gh|glab|kf)(?:\.exe)?\s+(?=[a-z-])/imu],
      ['provider command identity', /\/(?:mp(?:-gh)?|kf):[a-z0-9-]+/iu],
      [
        'concrete model',
        /(?:\bmodel.{0,20}\b(?:opus|sonnet|haiku)\b|\b(?:opus|sonnet|haiku)\b.{0,20}\bmodel)|appropriate runtime class/iu,
      ],
    ];
    for (const identity of identities) {
      for (const file of await files(identity)) {
        const content = await readFile(file, 'utf8');
        for (const [kind, pattern] of forbidden) {
          if (pattern.test(content)) {
            violations.push(`${path.relative(root, file)}: ${kind}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('uses canonical mpx agent identities for owned delegated roles', async () => {
    const violations: string[] = [];
    const owned = [
      'executor',
      'git-committer',
      'issue-analyzer',
      'context7-docs-fetcher',
      'ui-variant-generator',
    ];
    for (const identity of identities) {
      const content = await skill(identity);
      for (const agent of owned) {
        if (new RegExp(`(?<!mp-)\\b${agent}\\b`, 'u').test(content)) {
          violations.push(`${identity}: ${agent}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
