import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { inventoryCanonical } from '../../src/index.js';
import providerCases from '../fixtures/content-batch-c5/provider-cases.json' with { type: 'json' };

const root = path.resolve(import.meta.dirname, '../../../../content/skills');
const identities = [
  'batch-execute',
  'commit-push-pr',
  'epic-review',
  'execute',
  'hitl',
  'repository-setup',
  'issue-create',
  'review-publish',
  'setup-react-native',
  'setup-sveltekit',
  'ship',
  'epic-create',
  'epic-decompose',
];
async function files(identity: string) {
  const directory = path.join(root, identity);
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}
async function skill(identity: string) {
  return readFile(path.join(root, identity, 'SKILL.md'), 'utf8');
}

describe('Batch C5 canonical workflows', () => {
  it('catalogs every mapped identity and retains all source support documents', async () => {
    const catalog = new Map(
      (await inventoryCanonical(root)).map((entry) => [entry.identity, entry]),
    );
    for (const identity of identities) {
      expect(catalog.has(identity), identity).toBe(true);
    }
    expect(await files('execute')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/CLOSE_OUT\.md$/u),
        expect.stringMatching(/mocking\.md$/u),
        expect.stringMatching(/tests\.md$/u),
      ]),
    );
    expect(await files('epic-review')).toHaveLength(4);
    await expect(
      stat(path.join(root, 'epic-decompose', 'ISSUE_TEMPLATE.md')),
    ).resolves.toBeDefined();
    await expect(
      stat(path.join(root, 'setup-react-native', 'PLATFORM_REFERENCE.md')),
    ).resolves.toBeDefined();
  });

  it('preserves execution, HITL, review, CI, board, and manual gates', async () => {
    const content = await Promise.all(identities.map(skill)).then((values) => values.join('\n'));
    for (const phrase of [
      'sequential',
      'HITL gate',
      'test',
      'review loop',
      'Manual testing',
      'structured remediation',
      'privacy',
      'platform',
    ]) {
      expect(content, phrase).toContain(phrase);
    }
  });

  it('requires dedicated worktrees for execute workflows without defaulting batch Issues to parallelism', async () => {
    const executeContent = await skill('execute');
    const batchExecuteContent = await skill('batch-execute');
    const batchReference = await readFile(path.join(root, 'batch-execute', 'REFERENCE.md'), 'utf8');

    expect(executeContent).toContain('Establish a dedicated isolated worktree for the Issue');
    expect(batchExecuteContent).toContain('Establish a dedicated isolated worktree for the batch');
    expect(batchExecuteContent).toContain('sequential by default');
    expect(batchReference).toContain('explicitly requested per-Issue parallelism');
  });

  it('documents GitHub, GitLab, and unsupported provider capability branches', async () => {
    for (const example of providerCases) {
      const content = await skill(example.skill);
      for (const phrase of example.required) {
        expect(content, `${example.provider}: ${phrase}`).toContain(phrase);
      }
    }
  });

  it('routes provider consumers through the shared native reference contract', async () => {
    for (const identity of identities) {
      const content = await Promise.all(
        (await files(identity))
          .filter((file) => file.endsWith('.md'))
          .map((file) => readFile(file, 'utf8')),
      ).then((parts) => parts.join('\n'));
      expect(content, identity).toContain('ISSUE_TRACKER.md');
      expect(content, identity).not.toContain('<launch-identity>');
    }
  });

  it('keeps launch identity and Review IDs immutable and closes support references', async () => {
    const content = await Promise.all(identities.map(skill)).then((values) => values.join('\n'));
    expect(content).toContain('ISSUE_TRACKER.md');
    expect(content).toContain('explicit Review ID');
    expect(content).toContain('never replace it from branch or provider discovery');
    const missing: string[] = [];
    for (const identity of identities) {
      for (const file of await files(identity)) {
        if (!file.endsWith('.md')) {
          continue;
        }
        const markdown = await readFile(file, 'utf8');
        for (const match of markdown.matchAll(/\[[^\]]*\]\((?!https?:|#)([^)#]+)(?:#[^)]+)?\)/gu)) {
          const reference = match[1];
          if (!reference) {
            continue;
          }
          try {
            const target = reference.startsWith('../shared/')
              ? path.resolve(root, '../instructions/shared', reference.slice('../shared/'.length))
              : path.resolve(path.dirname(file), reference);
            await stat(target);
          } catch {
            missing.push(`${path.relative(root, file)} -> ${reference}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
