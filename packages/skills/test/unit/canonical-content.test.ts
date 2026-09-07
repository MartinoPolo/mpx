import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inventoryCanonical } from '../../src/index.js';

const canonicalRoot = path.resolve(import.meta.dirname, '../../../../content/skills');
const classifiedSkills = {
  'core/full': ['execute', 'issue-view', 'review'],
  'core/name-only': ['issue-create', 'issue-refine', 'ship'],
  'work/name-only': [
    'architecture-review',
    'bug-report',
    'check-fix',
    'code-clean',
    'commit',
    'commit-push',
    'commit-push-pr',
    'components-audit',
    'consolidate-context',
    'decompose',
    'design-brief',
    'design-init',
    'design-refine',
    'fallow-fix',
    'grill',
    'handoff',
    'notebooklm',
    'review-publish',
    'script-discovery',
    'skill-audit',
    'skill-create',
    'suppression-audit',
    'symlink',
    'sync-base',
    'vocabulary',
  ],
  'work/explicit-only': [
    'agent-create',
    'batch-execute',
    'continue',
    'epic-create',
    'epic-decompose',
    'epic-review',
    'grill-voice',
    'harvest-decisions',
    'hitl',
    'mockup',
    'playwright-test',
    'repository-setup',
    'setup-react-native',
    'setup-sveltekit',
  ],
  'personal/explicit-only': [
    'board-setup',
    'board-to-issues',
    'clean-pc',
    'podcast',
    'project-register',
    'tutorial-create',
    'video-to-image',
  ],
} as const;

async function normalizedSkill(identity: string): Promise<string> {
  return (await readFile(path.join(canonicalRoot, identity, 'SKILL.md'), 'utf8')).replace(
    /\r\n/gu,
    '\n',
  );
}

describe('canonical content contracts', () => {
  it('loads and classifies the complete Phase F skill inventory', async () => {
    const catalog = await inventoryCanonical(canonicalRoot);
    const actual = new Map<string, typeof catalog>();
    for (const skill of catalog) {
      const classification = `${skill.skillPacks.join('+')}/${skill.defaultExposure}`;
      actual.set(classification, [...(actual.get(classification) ?? []), skill]);
    }
    expect(
      Object.fromEntries(
        [...actual].map(([classification, skills]) => [
          classification,
          skills.map((skill) => skill.identity).sort(),
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(classifiedSkills).map(([classification, identities]) => [
          classification,
          [...identities].sort(),
        ]),
      ),
    );
  });

  it('ships the trusted provider resolution contract and references', async () => {
    const shared = path.resolve(canonicalRoot, '../instructions/shared');
    const contract = await readFile(path.join(shared, 'ISSUE_TRACKER.md'), 'utf8');
    expect(contract).toContain('stop at the nearest `mpxconfig.json`');
    expect(contract).toContain('Do not skip an invalid nearer file');
    expect(contract).toContain('This project-only check must not depend on user identity');
    expect(contract).toContain('Only for forge-backed GitHub, GitLab, or Gerrit operations');
    expect(contract).toContain('if the caller supplied a repository target');
    expect(contract).toContain(
      'use the remote-derived target without asking the caller to repeat it',
    );
    expect(contract).toContain('Non-forge providers do not use steps 3–4');
    expect(contract).toContain('`issues.provider`');
    expect(contract).toContain('`repository.provider`');
    expect(contract).toContain('Git remote **name**, not a forge project');
    expect(contract).toContain('git remote get-url -- <repository.remote>');
    expect(contract).toContain('Do not use `project.id` as forge identity');
    expect(contract).toContain('Merge always requires fresh human authorization');
    const references = Object.fromEntries(
      await Promise.all(
        ['GITHUB.md', 'GITLAB.md', 'KANBANFLOW.md', 'GERRIT.md', 'LOCAL.md'].map(async (name) => [
          name,
          await readFile(path.join(shared, 'providers', name), 'utf8'),
        ]),
      ),
    );
    expect(references['GITHUB.md']).toContain('gh issue view <id> --repo <target>');
    expect(references['GITHUB.md']).toContain('--json name,state,bucket,link [--watch]');
    expect(references['GITLAB.md']).toContain(
      'glab issue view <iid> --repo <TARGET> --output json',
    );
    expect(references['GITLAB.md']).toContain('projects/<ENCODED_PROJECT>/pipelines/<pipeline-id>');
    expect(references['KANBANFLOW.md']).toContain('kf board --json');
    expect(references['KANBANFLOW.md']).toContain('kf task view <task> --json');
    expect(references['GERRIT.md']).toContain('gerrit query --format=JSON');
    expect(references['GERRIT.md']).toContain('git push <configured-remote-name>');
    expect(references['LOCAL.md']).toContain('createConfiguredNodeLocalIssueStore');
    expect(references['LOCAL.md']).toContain('schemaVersion: 2');
  });

  it('keeps every imported skill free of forbidden namespaces, provider CLIs, paths, and placeholders', async () => {
    const violations: string[] = [];
    const catalog = await inventoryCanonical(canonicalRoot);
    for (const { identity } of catalog) {
      const content = await normalizedSkill(identity);
      const forbidden: Array<[string, RegExp]> = [
        ['provider CLI invocation', /(?:^|[\n`$;|&])\s*(?:gh|glab|kf)(?:\.exe)?\s+(?=[a-z-])/imu],
        [
          'provider comparison table',
          /^(?:\s*\|[^\n]*(?:provider[^\n]*command|command[^\n]*provider|GitHub|GitLab|KanbanFlow)[^\n]*\|\s*)$/imu,
        ],
        ['legacy identity', /\/(?:mp(?:-gh)?|kf):[a-z0-9-]+/iu],
        ['runtime placeholder', /(?:\$ARGUMENTS|\$\{[^}]+\}|\{\{[^}]+\}\})/u],
        [
          'absolute machine path',
          /(?:\b[A-Za-z]:[\\/](?:Users|_MP_projects|_MP_work|_MP_apps)[\\/]|\/(?:Users|home|_MP_projects|_MP_work|_MP_apps)\/)/u,
        ],
      ];
      for (const [kind, pattern] of forbidden) {
        if (pattern.test(content)) {
          violations.push(`${identity}: ${kind}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
