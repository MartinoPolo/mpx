import { describe, expect, it } from 'vitest';
import { frontmatter } from '../../src/frontmatter.js';

function document(lines: string[], newline: string): string {
  return ['---', ...lines, '---', 'Skill body', ''].join(newline);
}

describe.each(['\n', '\r\n'])('frontmatter scalar parsing with %j line endings', (newline) => {
  it.each([
    'Read, Write, WebFetch, WebSearch, Bash(pnpm ingest:gifts *)',
    "'Read, Write, WebFetch, WebSearch, Bash(pnpm ingest:gifts *)'",
  ])('accepts the Prejemesi allowed-tools value %s', (value) => {
    expect(frontmatter(document([`allowed-tools: ${value}`], newline))).toEqual({
      data: { 'allowed-tools': 'Read, Write, WebFetch, WebSearch, Bash(pnpm ingest:gifts *)' },
      body: ['Skill body', ''].join(newline),
    });
  });

  it.each([
    ['Research & development!', 'Research & development!'],
    ['Bash(gh *)', 'Bash(gh *)'],
    ["'*alias !tag &anchor <<: literal'", '*alias !tag &anchor <<: literal'],
    ['"*alias !tag &anchor <<: literal"', '*alias !tag &anchor <<: literal'],
    ["'Researcher''s *literal'", "Researcher's *literal"],
    ['"Say \\"hello\\" & continue!"', 'Say "hello" & continue!'],
  ])('accepts literal punctuation in %s', (value, expected) => {
    expect(frontmatter(document([`description: ${value}`], newline)).data.description).toBe(
      expected,
    );
  });

  it('parses string arrays without splitting quoted commas or interpreting quoted constructs', () => {
    const value = `[Bash(gh *), Research & development!, '*alias, !tag &anchor <<: literal', "Say \\"hello, world\\"!", 'Researcher''s, notes', '', ""]`;
    expect(frontmatter(document([`tools: ${value}`], newline)).data.tools).toEqual([
      'Bash(gh *)',
      'Research & development!',
      '*alias, !tag &anchor <<: literal',
      'Say "hello, world"!',
      "Researcher's, notes",
      '',
      '',
    ]);
  });

  it('keeps booleans, integers, empty arrays, and plain string arrays supported', () => {
    expect(
      frontmatter(
        document(
          ['enabled: true', 'disabled: false', 'version: 1', 'empty: []', 'packs: [core]'],
          newline,
        ),
      ).data,
    ).toEqual({ enabled: true, disabled: false, version: 1, empty: [], packs: ['core'] });
  });

  it.each([
    '*alias',
    '&anchor literal',
    '!tag literal',
    '!!str literal',
    '!<tag:example.com,2026:string> literal',
    '[*alias]',
    '[safe, *alias]',
    '[&anchor literal]',
    '[safe, !tag literal]',
    '["safe, literal", !!str literal]',
    '[<<: *alias]',
    '[{<<: *alias}]',
  ])('rejects actual YAML constructs in %s', (value) => {
    expect(() => frontmatter(document([`description: ${value}`], newline))).toThrow();
  });

  it.each([
    "'unterminated",
    '"unterminated',
    '"literal" trailing',
    '["literal" trailing]',
    '["literal", "unterminated]',
    '[safe',
    '[safe,, next]',
    '[[nested]]',
    '[true]',
    '[1]',
    '{key: value}',
    'key: value',
  ])('rejects malformed or unsupported values in %s', (value) => {
    expect(() => frontmatter(document([`description: ${value}`], newline))).toThrow();
  });

  it.each([
    ['<<: *alias'],
    ['metadata:', '  <<: *alias'],
    ['description: first', 'description: second'],
    ['metadata:', '  name: first', '  name: second'],
    ['description malformed'],
  ])('still rejects merge keys, duplicate keys, and malformed maps: %j', (...lines) => {
    expect(() => frontmatter(document(lines, newline))).toThrow();
  });
});
