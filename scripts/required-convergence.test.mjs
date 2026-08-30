import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runRequiredConvergence } from './required-convergence.mjs';

describe('required source convergence gate', () => {
  it('runs the real drift verifier when both configured legacy source roots exist', async () => {
    const projects = await mkdtemp(path.join(tmpdir(), 'mpx-required-convergence-'));
    try {
      await Promise.all([
        mkdir(path.join(projects, 'mpx-claude-code')),
        mkdir(path.join(projects, 'mpx-pi')),
      ]);
      const run = vi.fn(async () => ({ exitCode: 0 }));
      await expect(
        runRequiredConvergence({ MPX_PROJECTS: projects }, { run }),
      ).resolves.toMatchObject({ status: 'verified' });
      expect(run).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringMatching(/generate-convergence-manifest\.mjs$/u), '--check'],
        expect.objectContaining({ env: expect.objectContaining({ MPX_PROJECTS: projects }) }),
      );
    } finally {
      await rm(projects, { recursive: true, force: true });
    }
  });

  it('fails closed with a stable result when MPX_PROJECTS is unset in CI', async () => {
    const write = vi.fn();
    await expect(runRequiredConvergence({ CI: 'true' }, { write, run: vi.fn() })).resolves.toEqual({
      status: 'failed',
      code: 'MPX_PROJECTS_REQUIRED',
      reason: 'MPX_PROJECTS is not configured',
    });
    expect(write).toHaveBeenCalledWith(
      'ERROR convergence:verify [MPX_PROJECTS_REQUIRED] — MPX_PROJECTS is not configured.',
    );
  });

  it('exits nonzero when the required gate cannot run in CI', () => {
    const environment = { ...process.env, CI: 'true' };
    delete environment.MPX_PROJECTS;
    const script = fileURLToPath(new URL('./required-convergence.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: environment });
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      'ERROR convergence:verify [MPX_PROJECTS_REQUIRED] — MPX_PROJECTS is not configured.',
    );
  });

  it.each(['mpx-claude-code', 'mpx-pi'])(
    'fails closed when the %s legacy source root is missing in CI',
    async (missingName) => {
      const projects = await mkdtemp(path.join(tmpdir(), 'mpx-required-convergence-'));
      const presentName = missingName === 'mpx-claude-code' ? 'mpx-pi' : 'mpx-claude-code';
      try {
        await mkdir(path.join(projects, presentName));
        const missing = path.join(projects, missingName);
        const write = vi.fn();
        await expect(
          runRequiredConvergence({ CI: '1', MPX_PROJECTS: projects }, { write, run: vi.fn() }),
        ).resolves.toEqual({
          status: 'failed',
          code: 'LEGACY_SOURCE_ROOTS_REQUIRED',
          reason: `legacy source roots are unavailable: ${missing}`,
          missing: [missing],
        });
        expect(write).toHaveBeenCalledWith(
          `ERROR convergence:verify [LEGACY_SOURCE_ROOTS_REQUIRED] — legacy source roots are unavailable: ${missing}.`,
        );
      } finally {
        await rm(projects, { recursive: true, force: true });
      }
    },
  );

  it('preserves an explicit local-development skip when MPX_PROJECTS is unset', async () => {
    const write = vi.fn();
    await expect(runRequiredConvergence({}, { write, run: vi.fn() })).resolves.toEqual({
      status: 'skipped',
      reason: 'MPX_PROJECTS is not configured',
    });
    expect(write).toHaveBeenCalledWith(
      'SKIP convergence:verify — MPX_PROJECTS is not configured; legacy source drift cannot be checked.',
    );
  });

  it('preserves an explicit local-development skip when legacy source roots are missing', async () => {
    const projects = await mkdtemp(path.join(tmpdir(), 'mpx-required-convergence-'));
    try {
      const missing = [path.join(projects, 'mpx-claude-code'), path.join(projects, 'mpx-pi')];
      const write = vi.fn();
      await expect(
        runRequiredConvergence({ MPX_PROJECTS: projects }, { write, run: vi.fn() }),
      ).resolves.toEqual({
        status: 'skipped',
        reason: `legacy source roots are unavailable: ${missing.join(', ')}`,
        missing,
      });
      expect(write).toHaveBeenCalledWith(
        `SKIP convergence:verify — legacy source roots are unavailable: ${missing.join(', ')}.`,
      );
    } finally {
      await rm(projects, { recursive: true, force: true });
    }
  });
});
