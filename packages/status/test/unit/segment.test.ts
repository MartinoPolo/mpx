import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  formatPortSegment,
  normalizePortSegment,
  parseStatusSnapshot,
  renderClaudePortSegment,
  renderPiPortSegment,
} from '../../src/index.js';

const fixtureNames = [
  'valid',
  'fixed-shared',
  'missing',
  'invalid',
  'stale',
  'external-conflict',
  'unknown-listener',
] as const;

async function fixture(name: (typeof fixtureNames)[number]) {
  const snapshot = JSON.parse(
    await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
  const text = (
    await readFile(new URL(`../fixtures/${name}.txt`, import.meta.url), 'utf8')
  ).trimEnd();
  return { snapshot, text };
}

describe('normalized port segment', () => {
  it('exposes stable runtime-neutral data without mutating the validated snapshot', async () => {
    const { snapshot } = await fixture('external-conflict');
    const validated = parseStatusSnapshot(snapshot);
    const before = structuredClone(validated);

    const segment = normalizePortSegment(validated);

    expect(segment).toEqual({
      resolution: 'valid',
      services: [{ id: 'web', port: 4102, listening: true, conflict: 'external', marker: '!' }],
    });
    expect(validated).toEqual(before);
  });

  it.each(fixtureNames)('formats the %s fixture from normalized data', async (name) => {
    const { snapshot, text } = await fixture(name);
    expect(formatPortSegment(normalizePortSegment(parseStatusSnapshot(snapshot)))).toBe(text);
  });
});

describe('runtime formatter parity', () => {
  it.each(fixtureNames)(
    'renders equivalent validated current-worktree ports for %s',
    async (name) => {
      const { snapshot, text } = await fixture(name);

      expect(renderClaudePortSegment(snapshot)).toBe(text);
      expect(renderPiPortSegment(snapshot)).toBe(text);
      expect(renderClaudePortSegment(snapshot)).toBe(renderPiPortSegment(snapshot));
    },
  );

  it('rejects malformed input at both runtime formatter entrypoints', () => {
    const malformed = { schemaVersion: 1, services: [] };
    expect(() => renderClaudePortSegment(malformed)).toThrow(/status snapshot/i);
    expect(() => renderPiPortSegment(malformed)).toThrow(/status snapshot/i);
  });
});
