import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { inventoryCanonical } from '../../src/index.js';

const canonicalRoot = path.resolve(import.meta.dirname, '../../../../content/skills');

describe('public skill identity continuity', () => {
  it('exposes the requested original names without retired aliases', async () => {
    const catalog = await inventoryCanonical(canonicalRoot);
    const identities = catalog.map(({ identity }) => identity);

    expect(identities).toEqual(
      expect.arrayContaining(['epic-create', 'to-issues', 'decompose', 'pr']),
    );
    for (const retired of [
      'epic-decompose',
      'review-publish',
      'repository-setup',
      'issue-view',
      'issue-refine',
    ]) {
      expect(identities).not.toContain(retired);
    }
  });

  it('keeps GitHub repository initialization in development and name-only', async () => {
    const catalog = await inventoryCanonical(canonicalRoot);

    expect(catalog.find(({ identity }) => identity === 'init-github-repo')).toMatchObject({
      author: 'MartinoPolo',
      category: 'setup',
      skillPacks: ['development'],
      defaultExposure: 'name-only',
    });
  });
});
