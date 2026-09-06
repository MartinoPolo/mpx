import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
  it('returns an init dry-run envelope without publishing', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-cli-init-dry-'));
    const io = captureIo();
    const ensure = vi.fn();

    expect(
      await run(['init', '--dry-run', '--json', '--cwd', cwd], io, {
        env: {},
        portService: { ensure } as never,
      }),
    ).toBe(0);
    expect(JSON.parse(io.out.join(''))).toMatchObject({
      ok: true,
      data: { plan: { schemaVersion: 1 }, suggestedManifest: { schemaVersion: 1 } },
    });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('admits confirmed init and publishes its exact discovered manifest', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-cli-init-confirm-'));
    const io = captureIo();
    const ensure = vi.fn(async () => ({ lease: { port: 4173 }, warnings: [] }));

    expect(
      await run(['init', '--confirm', '--json', '--cwd', cwd], io, {
        env: {},
        portService: { ensure } as never,
      }),
    ).toBe(0);
    expect(JSON.parse(io.out.join(''))).toMatchObject({
      ok: true,
      data: { confirmed: true, lease: { port: 4173 } },
    });
    await expect(access(path.join(cwd, 'mpxconfig.json'))).resolves.toBeUndefined();
    expect(ensure).toHaveBeenCalledOnce();
  });

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
