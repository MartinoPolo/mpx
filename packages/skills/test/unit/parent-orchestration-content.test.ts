import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const contentRoot = path.resolve(import.meta.dirname, '../../../../content');

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(contentRoot, relativePath), 'utf8');
}

async function markdownUnder(relativeDirectory: string): Promise<string> {
  const directory = path.join(contentRoot, relativeDirectory);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const markdown = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
  return Promise.all(
    markdown.map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
  ).then((files) => files.join('\n'));
}

describe('parent-owned check and CI workflow content', () => {
  it('routes workflow callers through report-only specialists and the shared orchestration contract', async () => {
    const callers = await Promise.all([
      read('skills/execute/SKILL.md'),
      read('skills/execute/CLOSE_OUT.md'),
      read('skills/check-fix/SKILL.md'),
      read('skills/ship/SKILL.md'),
      read('skills/batch-execute/SKILL.md'),
    ]);

    for (const caller of callers) {
      expect(caller).toContain('REPAIR_ORCHESTRATION.md');
      expect(caller).not.toMatch(/mpx-(?:check|ci)-fixer/u);
    }

    expect(callers.join('\n')).toContain('mpx-check-reporter');
    expect(callers.join('\n')).toContain('mpx-ci-analyzer');

    const contract = await read('instructions/shared/REPAIR_ORCHESTRATION.md');
    expect(contract).toContain('The invoking skill is the parent');
    expect(contract).toContain('does not run checks, edit files, delegate');
    expect(contract).toMatch(/does not edit, delegate,\s+rerun jobs, commit, push/u);
    expect(contract).toMatch(/confirms\s+its fresh result/u);
  });

  it('removes the architecture scanner caller and invalid semantic model literals', async () => {
    const branches = await read('skills/epic-review/ANALYSIS_BRANCHES.md');
    expect(branches).not.toContain('mpx-scanner-architecture');
    expect(branches).toContain('existing `architecture-review` method');
    expect(branches).toContain('mpx-explorer');

    const skills = await markdownUnder('skills');
    expect(skills).not.toContain('model: "appropriate runtime class"');
    expect(skills).not.toContain('modelClass');
  });
});
