import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { generatePiAgents } from '../../src/index.js';
import { fileURLToPath } from 'node:url';

const modelMappings = Object.freeze({
  schemaVersion: 1 as const,
  runtime: 'pi' as const,
  models: Object.freeze({
    luna: 'openai-codex/gpt-5.6-luna',
    sol: 'openai-codex/gpt-5.6-sol',
    terra: 'openai-codex/gpt-5.6-terra',
  }),
});

async function writeAgentFixture(
  root: string,
  metadata: string,
): Promise<{ source: string; output: string; modelMappings: typeof modelMappings }> {
  const source = path.join(root, 'source');
  const output = path.join(root, 'out');
  await mkdir(source);
  await writeFile(
    path.join(source, 'mpx-alpha.md'),
    '---\nname: mpx-alpha\ndescription: alpha\n---\nBody\n',
  );
  await writeFile(path.join(source, 'metadata.json'), metadata);
  return { source, output, modelMappings };
}
it('rethrows the native SyntaxError for malformed catalog JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-json-'));
  const fixture = await writeAgentFixture(root, '{');
  let expected: SyntaxError;
  try {
    JSON.parse('{');
    throw new Error('expected JSON parse failure');
  } catch (error) {
    expected = error as SyntaxError;
  }
  await expect(generatePiAgents(fixture)).rejects.toMatchObject({
    constructor: SyntaxError,
    name: 'SyntaxError',
    message: expected.message,
  });
});

it('keeps metadata required for native Pi generation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-metadata-required-'));
  const fixture = await writeAgentFixture(root, '{}');
  await import('node:fs/promises').then((fs) => fs.rm(path.join(fixture.source, 'metadata.json')));

  await expect(generatePiAgents(fixture)).rejects.toMatchObject({
    name: 'AgentDocumentError',
    code: 'AGENT_METADATA_INVALID',
    message: 'metadata could not be read',
  });
});

it('preserves the native Pi diagnostic for a non-regular metadata path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-metadata-directory-'));
  const fixture = await writeAgentFixture(root, '{}');
  const metadataPath = path.join(fixture.source, 'metadata.json');
  await import('node:fs/promises').then(async (fs) => {
    await fs.rm(metadataPath);
    await fs.mkdir(metadataPath);
  });

  await expect(generatePiAgents(fixture)).rejects.toMatchObject({
    name: 'AgentDocumentError',
    code: 'AGENT_METADATA_INVALID',
    message: 'metadata must be a regular non-symlink file',
  });
});

it('preserves the generic Pi validation diagnostic', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-schema-'));
  const fixture = await writeAgentFixture(root, JSON.stringify({ schemaVersion: 1, agents: [] }));
  await expect(generatePiAgents(fixture)).rejects.toEqual(new Error('invalid agent metadata'));
});

it('preserves the Pi coverage diagnostic', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-coverage-'));
  const fixture = await writeAgentFixture(root, JSON.stringify({ schemaVersion: 1, agents: {} }));
  await expect(generatePiAgents(fixture)).rejects.toEqual(
    new Error('agent metadata must exactly cover canonical agents'),
  );
});

it('preserves the Pi unresolved selector diagnostic', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-selector-'));
  const fixture = await writeAgentFixture(
    root,
    JSON.stringify({
      schemaVersion: 1,
      agents: {
        'mpx-alpha': {
          modelClass: 'terra',
          thinking: 'low',
          capabilities: ['read'],
          nesting: ['mpx-missing*'],
          outputSchema: 'text',
        },
      },
    }),
  );
  await expect(generatePiAgents(fixture)).rejects.toEqual(
    new Error("agent nesting selector 'mpx-missing*' does not resolve to a canonical identity"),
  );
});

it('normalizes canonical CRLF bytes to the native Pi LF projection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-crlf-'));
  const fixture = await writeAgentFixture(
    root,
    JSON.stringify({
      schemaVersion: 1,
      agents: {
        'mpx-alpha': {
          modelClass: 'terra',
          thinking: 'low',
          capabilities: ['read'],
          nesting: [],
          outputSchema: 'text',
        },
      },
    }),
  );
  await writeFile(
    path.join(fixture.source, 'mpx-alpha.md'),
    '---\r\nname: mpx-alpha\r\ndescription: alpha\r\n---\r\nBody\r\n',
  );

  await generatePiAgents(fixture);

  expect(await readFile(path.join(fixture.output, 'mpx-alpha.md'))).toEqual(
    Buffer.from(
      '---\nname: mpx-alpha\ndescription: alpha\nmodel: openai-codex/gpt-5.6-terra\nthinking: low\ntools: read\noutput_schema: text\n\n---\nBody\n',
    ),
  );
});

it('translates the supplied Pi agent model mappings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-mapping-'));
  const fixture = await writeAgentFixture(
    root,
    JSON.stringify({
      schemaVersion: 1,
      agents: {
        'mpx-alpha': {
          modelClass: 'terra',
          thinking: 'low',
          capabilities: ['read'],
          nesting: [],
          outputSchema: 'text',
        },
      },
    }),
  );
  await generatePiAgents({
    ...fixture,
    modelMappings: {
      ...modelMappings,
      models: { ...modelMappings.models, terra: 'provider/custom-terra' },
    },
  });
  expect(await readFile(path.join(fixture.output, 'mpx-alpha.md'), 'utf8')).toContain(
    'model: provider/custom-terra',
  );
});

it('generates runtime metadata, the Explore alias, and detects exact catalog drift', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'out');
  await import('node:fs/promises').then((x) => x.mkdir(source));
  await writeFile(
    path.join(source, 'mpx-explorer.md'),
    '---\nname: mpx-explorer\ndescription: Exact Explore description\n---\nBody\n',
  );
  await writeFile(
    path.join(source, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      agents: {
        'mpx-explorer': {
          modelClass: 'terra',
          thinking: 'low',
          capabilities: ['read', 'search', 'shell'],
          nesting: [],
          outputSchema: 'text',
        },
      },
    }),
  );
  expect(await generatePiAgents({ source, output, modelMappings })).toEqual({
    changed: ['Explore.md'],
    drift: [],
  });
  const projected = await readFile(path.join(output, 'Explore.md'), 'utf8');
  expect(projected).toContain(
    'name: Explore\ndescription: Exact Explore description\nmodel: openai-codex/gpt-5.6-terra\nthinking: low\ntools: read,grep,find,ls,bash\noutput_schema: text',
  );
  expect(projected).not.toContain('model: inherit');
  await expect(readFile(path.join(output, 'mpx-explorer.md'), 'utf8')).rejects.toThrow();
  await writeFile(path.join(output, 'mpx-stale.md'), 'stale');
  expect((await generatePiAgents({ source, output, modelMappings, check: true })).drift).toEqual([
    'mpx-stale.md',
  ]);
  await writeFile(path.join(output, 'notes.md'), 'unrelated');
  await generatePiAgents({ source, output, modelMappings });
  await expect(readFile(path.join(output, 'mpx-stale.md'), 'utf8')).rejects.toThrow();
  await expect(readFile(path.join(output, 'notes.md'), 'utf8')).resolves.toBe('unrelated');
});

it('keeps the maintained projection aligned with canonical agents, aliases, and drift', async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const source = path.resolve(packageRoot, '../../../content/agents');
  const output = path.join(packageRoot, 'projection/agents');
  const catalog = JSON.parse(await readFile(path.join(source, 'metadata.json'), 'utf8')) as {
    agents: Record<string, unknown>;
  };
  const expectedNames = Object.keys(catalog.agents)
    .map((identity) => `${identity === 'mpx-explorer' ? 'Explore' : identity}.md`)
    .sort();

  const result = await generatePiAgents({ source, output, modelMappings, check: true });
  expect(result.drift).toEqual([]);
  const names = (await readdir(output)).filter((name) => name.endsWith('.md')).sort();
  expect(names).toEqual(expectedNames);
  expect(names.filter((name) => name === 'Explore.md')).toHaveLength(1);
  expect(names).not.toContain('mpx-explorer.md');
});

it('expands approved nesting patterns to concrete canonical identities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-nesting-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'out');
  await import('node:fs/promises').then((x) => x.mkdir(source));
  const metadata = {
    modelClass: 'terra',
    thinking: 'low',
    capabilities: ['read'],
    nesting: [],
    outputSchema: 'text',
  };
  for (const identity of ['mpx-parent', 'mpx-reviewer-a', 'mpx-reviewer-b']) {
    await writeFile(
      path.join(source, `${identity}.md`),
      `---\nname: ${identity}\ndescription: ${identity}\n---\nBody\n`,
    );
  }
  await writeFile(
    path.join(source, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      agents: {
        'mpx-parent': { ...metadata, nesting: ['mpx-reviewer-b', 'mpx-reviewer-*'] },
        'mpx-reviewer-a': metadata,
        'mpx-reviewer-b': metadata,
      },
    }),
  );
  await generatePiAgents({ source, output, modelMappings });
  const projected = await readFile(path.join(output, 'mpx-parent.md'), 'utf8');
  expect(projected).toBe(
    '---\nname: mpx-parent\ndescription: mpx-parent\nmodel: openai-codex/gpt-5.6-terra\nthinking: low\ntools: read\noutput_schema: text\nallowed_subagents: mpx-reviewer-b,mpx-reviewer-a\n\n---\nBody\n',
  );
});
