import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/main.js';
import { captureIo } from '../../src/io.js';

const deletedRoutes = [
  ...['enroll', 're-enroll', 'list', 'status', 'verify'].map((action) => ['account', action]),
  ...['intent', 'prepare', 'plan', 'apply', 'verify', 'rollback', 'uninstall'].map((action) => [
    'install',
    action,
  ]),
  ...['show', 'resolve', 'explain', 'validate'].map((action) => ['config', action]),
  ...['list', 'explain', 'doctor'].map((action) => ['provider', action]),
  ...['list', 'search', 'show', 'explain', 'complete'].map((action) => ['skill', action]),
  ...['identity', 'mode', 'skill-policy', 'preset'].flatMap((group) => [
    [group, 'list'],
    [group, 'show'],
  ]),
  ['runtime', 'claude'],
  ['runtime', 'pi'],
  ['view', 'rebuild'],
  ['content', 'current'],
  ['content', 'list'],
  ['content', 'show'],
  ['launch', 'explain'],
  ['launch', 'current'],
  ['launch', 'sbx-plan-export'],
  ['issue', 'show'],
  ['issue', 'update'],
  ['issue', 'close'],
  ['session', 'show'],
  ['session', 'save'],
  ['session', 'branch'],
  ['session', 'mark'],
  ['session', 'handoff'],
  ['session', 'complete'],
  ['session', 'completion'],
  ['session', 'inbox'],
  ['session', 'reconcile'],
  ['cc'],
  ['ccw'],
  ['pi'],
  ['piw'],
] as const;

describe('canonical CLI dispatch', () => {
  it.each(deletedRoutes.map((route) => [route]))('rejects deleted route %s', async (route) => {
    const io = captureIo();

    expect(await run([...route], io, { env: {} })).toBe(2);
    expect(io.err.join('')).toContain('USAGE_ERROR');
  });

  it('executes internal resurrection without revealing it in direct help', async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), 'mpx-cli-routing-'));
    const executeIo = captureIo();

    expect(
      await run(['session', 'resurrect-export', '--json'], executeIo, {
        env: { LOCALAPPDATA: localAppData },
      }),
    ).toBe(0);
    expect(JSON.parse(executeIo.out.join(''))).toMatchObject({
      ok: true,
      data: { schemaVersion: 1, records: [] },
    });

    const helpIo = captureIo();
    expect(await run(['session', 'resurrect-export', '--help'], helpIo, { env: {} })).toBe(0);
    expect(helpIo.out.join('')).not.toContain('resurrect-export');
  });
});
