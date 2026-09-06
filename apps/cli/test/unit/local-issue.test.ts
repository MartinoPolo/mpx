import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { captureIo } from '../../src/io.js';
import { run } from '../../src/main.js';

it('runs canonical local issue and dependency commands without an identity route', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-local-cli-')),
    appdata = await mkdtemp(path.join(tmpdir(), 'mpx-local-config-')),
    issues = path.join(appdata, 'issues'),
    vault = path.join(appdata, 'vault'),
    output = path.join(vault, 'MPX', 'Issues');
  await mkdir(path.join(cwd, '.git'));
  await mkdir(path.join(appdata, 'mpx'));
  await mkdir(vault);
  await writeFile(
    path.join(cwd, 'mpxconfig.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: 'acme/app' },
      repository: { provider: 'generic', remote: 'origin' },
      issues: { provider: 'local', store: 'test-issues', view: 'test-view' },
    }),
  );
  await writeFile(
    path.join(appdata, 'mpx', 'config.json'),
    JSON.stringify({
      identities: {},
      domains: {},
      contentScopes: {},
      modes: {},
      skillPolicies: {},
      presets: {},
      launchDefaults: { scopes: {}, projects: {} },
      networkPolicies: {},
      executors: { host: {} },
      localIssueStores: { 'test-issues': { root: issues } },
      localViews: {
        'test-view': {
          vaultRoot: vault,
          outputRoot: output,
          vaultSubtree: 'MPX/Issues',
          resumeBaseUrl: 'mpx://resume',
        },
      },
    }),
  );
  const command = async (args: string[]) => {
    const io = captureIo();
    expect(
      await run(['--json', '--cwd', cwd, ...args], io, { env: { APPDATA: appdata } }),
      io.out.join('\n'),
    ).toBe(0);
    return JSON.parse(io.out[0]!).data;
  };
  expect(await command(['issue', 'create', '--title', 'A', '--body', 'B'])).toMatchObject({
    id: '1',
  });
  expect(await readFile(path.join(output, '000001-a.md'), 'utf8')).toContain('# 1: A');
  await command(['issue', 'create', '--title', 'Dependency', '--body', '']);
  expect(
    await command(['issue', 'dependency', 'add', '--id', '1', '--dependency-id', '2']),
  ).toMatchObject({ id: '1' });
  expect(await command(['issue', 'view', '--id', '1'])).toMatchObject({
    providerData: { local: { dependencies: { frontier: ['2'] } } },
  });
  expect(
    await command(['issue', 'edit', '--id', '1', '--title', 'Updated', '--body', 'Body']),
  ).toMatchObject({ title: 'Updated' });
  expect(await command(['issue', 'finish', '--id', '1'])).toMatchObject({ state: 'finished' });
}, 5_000);
