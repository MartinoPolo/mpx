import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

it.skipIf(process.platform !== 'win32')(
  'runs checkout setup with inherited settings and propagates its exit status',
  async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'mpx checkout setup '));
    try {
      await Promise.all(
        ['scripts', 'bin', 'packages/installer/src'].map((directory) =>
          mkdir(path.join(fixtureRoot, directory), { recursive: true }),
        ),
      );
      await copyFile(
        path.join(repositoryRoot, 'scripts/setup.ps1'),
        path.join(fixtureRoot, 'scripts/setup.ps1'),
      );
      await writeFile(
        path.join(fixtureRoot, 'packages/installer/src/windows-owned-paths.json'),
        JSON.stringify(['MPX_NODE_EXECUTABLE', 'MPX_APPS']),
      );
      await writeFile(
        path.join(fixtureRoot, 'bin/mpx.mjs'),
        'console.log(JSON.stringify({args: process.argv.slice(2), apps: process.env.MPX_APPS})); process.exitCode = 17;',
      );
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-File', path.join(fixtureRoot, 'scripts/setup.ps1')],
        {
          cwd: tmpdir(),
          env: { ...process.env, MPX_NODE_EXECUTABLE: process.execPath, MPX_APPS: fixtureRoot },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(17);
      expect(JSON.parse(result.stdout.trim())).toEqual({ args: ['setup'], apps: fixtureRoot });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  },
);
