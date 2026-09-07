import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  commandAction,
  commandLeaves,
  commandRegistry,
  renderActionHelp,
  renderBasicReference,
  renderCompleteReference,
} from '../../src/command-metadata.js';

const humanLeaves = [
  'setup',
  'doctor',
  'init',
  'launch pi',
  'launch claude',
  'content inspect',
  'content check',
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

const agentLeaves: string[] = [];

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
      ['setup', 'doctor', 'init', 'launch', 'content', 'session', 'workspace', 'port'].sort(),
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

  it('permits internal lookup without revealing internal direct-action help', () => {
    const group = commandRegistry.find((entry) => entry.name === 'session')!;
    const item = commandAction('session', 'resurrect-export');

    expect(item?.audience).toBe('internal');
    expect(renderActionHelp(group, item!)).not.toContain('resurrect-export');
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
