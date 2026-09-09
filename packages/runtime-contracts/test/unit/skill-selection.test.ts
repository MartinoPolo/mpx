import { describe, expect, it } from 'vitest';
import { parseSkillSelection } from '../../src/index.js';

function parse(location: { name: string; canonicalRoot: string }) {
  return parseSkillSelection(
    { location, packs: ['development'], source: 'user-location' },
    (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  );
}

describe('resolved skill selection locations', () => {
  it.each([
    ['an overlong name', { name: 'a'.repeat(65), canonicalRoot: '/opt/mpx' }],
    ['an invalid label', { name: 'Invalid Label', canonicalRoot: '/opt/mpx' }],
    ['a relative root', { name: 'coding', canonicalRoot: 'skills/canonical' }],
    ['an overlong root', { name: 'coding', canonicalRoot: `/${'a'.repeat(4096)}` }],
  ])('rejects %s', (_case, location) => {
    expect(() => parse(location)).toThrow(/INVALID_CONTRACT/u);
  });

  it.each(['/opt/mpx/skills', String.raw`C:\projects\mpx\skills`])(
    'accepts an established absolute root format: %s',
    (canonicalRoot) => {
      expect(parse({ name: 'coding-tools', canonicalRoot })).toMatchObject({
        location: { name: 'coding-tools', canonicalRoot },
      });
    },
  );
});
