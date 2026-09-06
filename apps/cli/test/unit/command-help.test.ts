import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  commandAction,
  commandLeaves,
  commandRegistry,
  renderActionHelp,
  renderAllHelp,
  renderBasicReference,
  renderCompleteReference,
  renderGroupHelp,
  renderRootHelp,
} from '../../src/command-metadata.js';

const humanLeaves = [
  'setup',
  'doctor',
  'init',
  'launch pi',
  'launch claude',
  'content inspect',
  'content check',
  'issue list',
  'issue view',
  'issue create',
  'issue edit',
  'issue comment',
  'issue finish',
  'review view',
  'review create',
  'review merge',
  'ci status',
  'ci logs',
  'session list',
  'session resume',
  'workspace list',
  'workspace show',
  'workspace create',
  'workspace remove',
  'workspace start',
  'workspace stop',
  'workspace logs',
  'port kill',
].sort();

const agentLeaves = [
  'issue label',
  'issue move',
  'issue dependency',
  'review update',
  'review comment',
  'review ready',
  'ci watch',
  'ci retry',
].sort();

const internalLeaves = ['session resurrect-export'];

describe('canonical CLI metadata', () => {
  it('defines the exact human command surface below the thirty-leaf limit', () => {
    const leaves = commandLeaves(['human']);

    expect(leaves).toEqual(humanLeaves);
    expect(leaves.length).toBeLessThan(30);
  });

  it('defines the exact agent command surface', () => {
    expect(commandLeaves(['agent'])).toEqual(agentLeaves);
  });

  it('retains only the required internal route and no experimental routes', () => {
    expect(commandLeaves(['internal'])).toEqual(internalLeaves);
    expect(commandLeaves(['experimental'])).toEqual([]);
  });

  it('retains only canonical command groups in metadata', () => {
    expect(commandRegistry.map((group) => group.name).sort()).toEqual(
      [
        'setup',
        'doctor',
        'init',
        'launch',
        'content',
        'issue',
        'review',
        'ci',
        'session',
        'workspace',
        'port',
      ].sort(),
    );
  });

  it('requires a closed audience value on every group and action', () => {
    const audiences = new Set(['human', 'agent', 'internal', 'experimental']);

    for (const group of commandRegistry) {
      expect(audiences.has(group.audience)).toBe(true);
      for (const item of group.actions) {
        expect(audiences.has(item.audience)).toBe(true);
      }
    }
  });

  it('renders only human commands in root and focused group help', () => {
    const root = renderRootHelp();
    const issue = renderGroupHelp(commandRegistry.find((group) => group.name === 'issue')!);

    expect(root).toContain('issue');
    expect(root).not.toContain('resurrect-export');
    expect(issue).toContain('finish');
    expect(issue).not.toContain('label');
    expect(issue).not.toContain('dependency');
  });

  it('renders human and agent commands, but not internal commands, in complete help', () => {
    const all = renderAllHelp();

    expect(all).toContain('issue finish');
    expect(all).toContain('issue label');
    expect(all).not.toContain('resurrect-export');
  });

  it('permits internal lookup without revealing internal direct-action help', () => {
    const group = commandRegistry.find((entry) => entry.name === 'session')!;
    const item = commandAction('session', 'resurrect-export');

    expect(item?.audience).toBe('internal');
    expect(renderActionHelp(group, item!)).not.toContain('resurrect-export');
  });

  it('generates a human-only basic reference and a human-plus-agent complete reference', () => {
    const basic = renderBasicReference();
    const complete = renderCompleteReference();

    expect(basic).toContain('mpx issue finish');
    expect(basic).not.toContain('mpx issue label');
    expect(complete).toContain('mpx issue label');
    expect(complete).not.toContain('resurrect-export');
  });

  it('keeps both generated CLI references synchronized with the typed registry', async () => {
    const shared = fileURLToPath(
      new URL('../../../../content/instructions/shared/', import.meta.url),
    );

    await expect(readFile(`${shared}/MPX_CLI_BASIC.md`, 'utf8')).resolves.toBe(
      renderBasicReference(),
    );
    await expect(readFile(`${shared}/MPX_CLI_REFERENCE.md`, 'utf8')).resolves.toBe(
      renderCompleteReference(),
    );
  });
});
