import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inventoryCanonical } from '../../src/index.js';

const canonicalRoot = path.resolve(import.meta.dirname, '../../../../content/skills');
const fixtureRoot = path.join(import.meta.dirname, '../fixtures/content-batch-c4');

async function skill(identity: string): Promise<string> {
  return (await readFile(path.join(canonicalRoot, identity, 'SKILL.md'), 'utf8')).replaceAll(
    '\r\n',
    '\n',
  );
}

async function cases(file: string): Promise<Array<{ name: string; required: string[] }>> {
  return JSON.parse(await readFile(path.join(fixtureRoot, file), 'utf8'));
}

describe('continue recovery behavior', async () => {
  for (const example of await cases('recovery-cases.json')) {
    // oxlint-disable-next-line vitest/valid-title -- fixture names intentionally define generated test titles
    it(example.name, async () => {
      const content = await skill('continue');
      for (const phrase of example.required) {
        expect(content, phrase).toContain(phrase);
      }
    });
  }
});

describe('harvest decision behavior', async () => {
  for (const example of await cases('harvest-cases.json')) {
    // oxlint-disable-next-line vitest/valid-title -- fixture names intentionally define generated test titles
    it(example.name, async () => {
      const content = await skill('harvest-decisions');
      for (const phrase of example.required) {
        expect(content, phrase).toContain(phrase);
      }
    });
  }
});

describe('Batch C4 catalog and portability', () => {
  it('catalogs both skills as explicit-only work skills', async () => {
    const catalog = await inventoryCanonical(canonicalRoot);
    expect(
      catalog
        .filter(({ identity }) => identity === 'continue' || identity === 'harvest-decisions')
        .map(({ identity, skillPacks, defaultExposure }) => ({
          identity,
          skillPacks,
          defaultExposure,
        })),
    ).toEqual([
      { identity: 'continue', skillPacks: ['work'], defaultExposure: 'explicit-only' },
      { identity: 'harvest-decisions', skillPacks: ['work'], defaultExposure: 'explicit-only' },
    ]);
  });

  it('uses only neutral runtime contracts and portable authorized roots', async () => {
    const content = `${await skill('continue')}\n${await skill('harvest-decisions')}`;
    const forbidden: Array<[string, RegExp]> = [
      ['Claude messaging/task tool', /\b(?:SendMessage|TaskList)\b/u],
      ['Claude private storage', /(?:~\/\.claude|[\\/]\.claude[\\/]|\.claude\/projects)/iu],
      ['native transcript format', /\b(?:JSONL|transcript file|transcript path)\b/iu],
      [
        'native process or port recovery',
        /\b(?:Get-NetTCPConnection|Stop-Process|lsof|netstat)\b|\bport\s+\d{2,5}\b/iu,
      ],
      ['legacy frontmatter tools', /^allowed-tools:/mu],
      [
        'absolute machine path',
        /\b[A-Za-z]:[\\/]|\/(?:Users|home|_MP_projects|_MP_work|_MP_apps)\//u,
      ],
    ];
    expect(forbidden.flatMap(([name, pattern]) => (pattern.test(content) ? [name] : []))).toEqual(
      [],
    );
    expect(await skill('continue')).toContain('runtime Agent contract');
    expect(await skill('continue')).toContain('runtime `dev_server` contract');
    expect(await skill('harvest-decisions')).toContain('launch-bound session discovery contract');
  });
});
