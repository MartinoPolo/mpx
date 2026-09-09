import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadRuntimeProfilesV1,
  parseRuntimeModelSelectionV1,
  parseRuntimeProfilesV1,
  runtimeAgentModelMappingsV1,
  defaultRuntimeModelSelectionV1,
} from '../../src/index.js';

const agentAliases = Object.fromEntries(
  [
    'mpx-check-fixer',
    'mpx-checker',
    'mpx-chrome-devtools-tester',
    'mpx-ci-fixer',
    'mpx-context7-docs-fetcher',
    'mpx-executor',
    'mpx-explorer',
    'mpx-git-committer',
    'mpx-issue-analyzer',
    'mpx-issue-finder',
    'mpx-review-manager',
    'mpx-reviewer-best-practices',
    'mpx-reviewer-code-quality',
    'mpx-reviewer-error-handling',
    'mpx-reviewer-performance',
    'mpx-reviewer-security',
    'mpx-reviewer-spec-alignment',
    'mpx-reviewer-test-quality',
    'mpx-scanner-architecture',
    'mpx-tdd-executor',
    'mpx-ui-variant-generator',
    'mpx-unresolved-issue-tracker',
  ].map((identity) => [identity, identity === 'mpx-explorer' ? 'Explore' : identity]),
);

const profile = {
  schemaVersion: 1,
  models: {
    claude: {
      mechanical: 'haiku',
      exploration: 'sonnet',
      standard: 'sonnet',
      advanced: 'opus',
      frontier: 'fable',
    },
    pi: {
      mechanical: 'openai-codex/gpt-5.6-luna',
      exploration: 'openai-codex/gpt-5.6-luna',
      standard: 'openai-codex/gpt-5.6-terra',
      advanced: 'openai-codex/gpt-5.6-sol',
      frontier: 'openai-codex/gpt-6-astra',
    },
  },
  agentTranslation: {
    runtimes: {
      claude: {
        aliases: agentAliases,
        capabilities: {
          mappings: {
            read: ['Read'],
            search: ['Grep', 'Glob'],
            shell: ['Bash'],
            write: ['Edit', 'Write'],
            browser: ['mcp__mpx_gateway__mcp'],
            context: ['mcp__mpx_gateway__mcp'],
            web: ['WebSearch', 'WebFetch'],
          },
        },
        frontmatter: {
          model: 'model',
          thinking: 'effort',
          tools: 'tools',
          outputSchema: 'output-schema',
          nesting: 'allowed-subagents',
        },
        separators: { tools: ', ', nesting: ',' },
        nestingRequiredTools: ['Agent'],
      },
      pi: {
        aliases: agentAliases,
        capabilities: {
          mappings: {
            read: ['read'],
            search: ['grep', 'find', 'ls'],
            shell: ['bash'],
            write: ['edit', 'write'],
            browser: ['mcp'],
            context: ['mcp'],
            web: ['web_search', 'fetch_content', 'get_search_content', 'source_check'],
          },
        },
        frontmatter: {
          model: 'model',
          thinking: 'thinking',
          tools: 'tools',
          outputSchema: 'output_schema',
          nesting: 'allowed_subagents',
        },
        separators: { tools: ', ', nesting: ',' },
        nestingRequiredTools: [],
      },
    },
  },
  contentTranslation: {
    nameOnlyDescriptionTemplate:
      'MPX skill {{identity}}. Load only when the user explicitly mentions {{identity}} by name.',
    runtimes: {
      claude: {
        argumentHint: 'supported',
        capabilities: {
          support: 'preapproved',
          mappings: {
            read: ['Read'],
            search: ['Glob', 'Grep'],
            shell: ['Bash'],
            write: ['Write', 'Edit'],
            delegate: ['Agent'],
          },
        },
        frontmatter: { argumentHint: 'argument-hint', capabilityGrant: 'allowed-tools' },
      },
      pi: {
        argumentHint: 'unsupported',
        capabilities: { support: 'unsupported', mappings: {} },
        frontmatter: { argumentHint: null, capabilityGrant: null },
      },
    },
  },
};

describe('runtime model profiles', () => {
  it('validates exact semantic and runtime coverage while permitting many-to-one mappings', () => {
    const parsed = parseRuntimeProfilesV1(JSON.stringify(profile));
    expect(parsed).toEqual(profile);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.models)).toBe(true);
    expect(Object.isFrozen(parsed.models.pi)).toBe(true);
    expect(runtimeAgentModelMappingsV1(parsed, 'pi')).toEqual({
      schemaVersion: 1,
      runtime: 'pi',
      models: profile.models.pi,
    });

    for (const invalid of [
      { ...profile, extra: true },
      { ...profile, models: { pi: profile.models.pi } },
      { ...profile, contentTranslation: { ...profile.contentTranslation, surprise: true } },
      { ...profile, models: { ...profile.models, other: profile.models.pi } },
      {
        ...profile,
        models: { ...profile.models, pi: { ...profile.models.pi, mechanical: '' } },
      },
      {
        ...profile,
        models: { ...profile.models, claude: { ...profile.models.claude, luna: 'haiku' } },
      },
    ]) {
      expect(() => parseRuntimeProfilesV1(JSON.stringify(invalid))).toThrow(/runtime profiles/);
    }
  });

  it.each([
    [
      'missing',
      { read: ['Read'], search: ['Glob', 'Grep'], shell: ['Bash'], write: ['Write', 'Edit'] },
    ],
    [
      'extra',
      {
        read: ['Read'],
        search: ['Glob', 'Grep'],
        shell: ['Bash'],
        write: ['Write', 'Edit'],
        delegate: ['Agent'],
        network: ['WebFetch'],
      },
    ],
  ])('rejects %s capability mappings for a grant-applying runtime', (_label, mappings) => {
    const invalid = {
      ...profile,
      contentTranslation: {
        ...profile.contentTranslation,
        runtimes: {
          ...profile.contentTranslation.runtimes,
          claude: {
            ...profile.contentTranslation.runtimes.claude,
            capabilities: { support: 'preapproved', mappings },
          },
        },
      },
    };

    expect(() => parseRuntimeProfilesV1(JSON.stringify(invalid))).toThrow(
      'runtime profiles contain invalid content translation',
    );
  });

  it.each(['{{other}}', '{{ identity }}', '{{identity}}, {{runtime}}'])(
    'rejects an undeclared name-only template token in %s',
    (token) => {
      const invalid = {
        ...profile,
        contentTranslation: {
          ...profile.contentTranslation,
          nameOnlyDescriptionTemplate: `MPX {{identity}} ${token}`,
        },
      };
      expect(() => parseRuntimeProfilesV1(JSON.stringify(invalid))).toThrow(
        'runtime profiles contain invalid content translation',
      );
    },
  );

  it.each(['Read,Write', 'Read\nWrite', 'Read\u0000Write', 'not valid', '9Read'])(
    'rejects invalid native capability mapping %j',
    (tool) => {
      const invalid = structuredClone(profile);
      invalid.contentTranslation.runtimes.claude.capabilities.mappings.read = [tool];
      expect(() => parseRuntimeProfilesV1(JSON.stringify(invalid))).toThrow(
        'runtime profiles contain invalid content translation',
      );
    },
  );

  it.each([
    [
      'missing capability',
      (value: any) => delete value.agentTranslation.runtimes.pi.capabilities.mappings.web,
    ],
    [
      'extra capability',
      (value: any) =>
        (value.agentTranslation.runtimes.pi.capabilities.mappings.delegate = ['agent']),
    ],
    [
      'missing alias section',
      (value: any) => delete value.agentTranslation.runtimes.claude.aliases,
    ],
    ['extra field', (value: any) => (value.agentTranslation.runtimes.pi.frontmatter.extra = 'x')],
    [
      'invalid field name',
      (value: any) => (value.agentTranslation.runtimes.pi.frontmatter.tools = 'allowed-tools'),
    ],
    [
      'control character',
      (value: any) => (value.agentTranslation.runtimes.pi.separators.tools = '\n'),
    ],
    [
      'case-insensitive alias collision',
      (value: any) =>
        (value.agentTranslation.runtimes.pi.aliases = {
          'mpx-a': 'Explore',
          'mpx-b': 'explore',
        }),
    ],
  ])('rejects invalid agent translation: %s', (_label, mutate) => {
    const invalid = structuredClone(profile);
    mutate(invalid);
    expect(() => parseRuntimeProfilesV1(JSON.stringify(invalid))).toThrow(
      'runtime profiles contain invalid agent translation',
    );
  });

  it('rejects invalid JSON', () => {
    expect(() => parseRuntimeProfilesV1('{"schemaVersion":1')).toThrow(
      'runtime profiles must be valid JSON',
    );
  });

  it('rejects a non-empty invalid Claude model ID', () => {
    const invalid = {
      ...profile,
      models: { ...profile.models, claude: { ...profile.models.claude, mechanical: 'bad/model' } },
    };

    expect(() => parseRuntimeProfilesV1(JSON.stringify(invalid))).toThrow(
      'runtime profiles contain invalid model mappings',
    );
  });

  it('rejects a non-empty invalid Pi model ID', () => {
    const invalid = {
      ...profile,
      models: { ...profile.models, pi: { ...profile.models.pi, mechanical: 'missing-provider' } },
    };

    expect(() => parseRuntimeProfilesV1(JSON.stringify(invalid))).toThrow(
      'runtime profiles contain invalid model mappings',
    );
  });

  it('loads the tracked profile as the canonical runtime mapping source', async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const file = path.resolve(packageRoot, '../../content/runtime-profiles.json');
    await expect(loadRuntimeProfilesV1(file)).resolves.toEqual(profile);
  });
});

describe('runtime model selection', () => {
  it('keeps the immutable Pi session model catalog separate from agent-class mappings', () => {
    const selection = defaultRuntimeModelSelectionV1('pi');
    expect(selection).toEqual({
      schemaVersion: 1,
      runtime: 'pi',
      provider: 'openai-codex',
      defaultModel: 'openai-codex/gpt-5.6-sol',
      enabledModels: [
        'openai-codex/gpt-5.6-luna',
        'openai-codex/gpt-5.6-sol',
        'openai-codex/gpt-5.6-terra',
      ],
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.enabledModels)).toBe(true);
    expect(parseRuntimeModelSelectionV1(selection)).toEqual(selection);
  });
});
