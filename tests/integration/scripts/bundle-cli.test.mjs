import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildBundleBytes, checkBundles } from '../../../scripts/bundle-cli.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );

function execute(entry, localAppData, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(options.nodeArgs ?? []), entry, ...(options.args ?? [])],
      {
        env: { ...process.env, LOCALAPPDATA: localAppData, ...options.env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (value) => (stdout += value));
    child.stderr.setEncoding('utf8').on('data', (value) => (stderr += value));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('generated CLI bundle validation', () => {
  it('builds the canonical Pi extension artifact before walking CLI release sources', async () => {
    const workspace = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

    expect(workspace.scripts['bundle:cli']).toBe(
      'pnpm --filter @mpx/pi-extensions run build:release && pnpm --filter @mpx/pi-extensions run verify:release && node scripts/bundle-cli.mjs',
    );
    expect(workspace.scripts['bundle:generate']).toBe('pnpm run bundle:cli');
  });

  it('executes the production bundle pipeline and leaves a verified artifact and CLI output', async () => {
    const command = process.platform === 'win32' ? process.env.ComSpec : 'corepack';
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'corepack pnpm run bundle:cli']
        : ['pnpm', 'run', 'bundle:cli'];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (value) => (stdout += value));
      child.stderr.setEncoding('utf8').on('data', (value) => (stderr += value));
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });

    expect(result).toMatchObject({ code: 0 });
    const metadata = JSON.parse(
      await readFile(
        path.join(root, 'runtimes', 'pi', 'extensions', 'dist', 'package', 'build-metadata.json'),
        'utf8',
      ),
    );
    expect(metadata.sourceTreeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(path.join(root, 'bin', 'mpx.mjs'), 'utf8')).toMatch(
      /canonical-source-sha256:[a-f0-9]{64}/u,
    );
  }, 90_000);

  it('builds deterministic bytes without mutating tracked bundles or evidence', async () => {
    const tracked = ['bin/mpx.mjs', 'bin/claude-gateway.js', 'evidence/executor-evidence.ts'];
    const before = await Promise.all(tracked.map((name) => readFile(path.join(root, name))));
    const first = await buildBundleBytes();
    const second = await buildBundleBytes();
    expect([...first.keys()]).toEqual([...second.keys()]);
    expect(first.has('bin/mpx-node.mjs')).toBe(false);
    for (const [name, bytes] of first) {
      expect(bytes.equals(second.get(name))).toBe(true);
    }
    const cli = first.get('bin/mpx.mjs').toString('utf8');
    expect(cli).not.toContain('The package "esbuild" cannot be bundled');
    expect(cli).not.toContain('var ESBUILD_VERSION');
    const after = await Promise.all(tracked.map((name) => readFile(path.join(root, name))));
    expect(after.map(sha)).toEqual(before.map(sha));
  }, 60_000);

  it('executes an entry generated through the production-minified CLI and rejects invalid bytes', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-bundled-entry-'));
    try {
      const sourceName = 'apps/cli/src/main.ts';
      const mainSource = await readFile(path.join(root, sourceName));
      const bundles = await buildBundleBytes({
        sourceOverrides: new Map([
          [
            sourceName,
            Buffer.concat([
              mainSource,
              Buffer.from("\nexport { buildStableNodeEntryBody } from '@mpx/installer';\n"),
            ]),
          ],
        ]),
      });
      const bundledCli = path.join(temporary, 'production-cli.mjs');
      await writeFile(bundledCli, bundles.get('bin/mpx.mjs'));
      const loaded = await import(`${pathToFileURL(bundledCli).href}?production-entry-regression`);
      const installation = path.join(temporary, 'installation');
      const localAppData = path.join(temporary, 'local');
      const entry = path.join(installation, 'bin', 'mpx-node.mjs');
      const payload =
        'console.log(process.env.MPX_CLAUDE_EXECUTABLE && process.env.MPX_PI_EXECUTABLE ? "bundle-entry-hydration-sentinel" : "missing");\n';
      const files = [
        { path: 'bin/mpx.mjs', bytes: Buffer.byteLength(payload), sha256: sha(payload) },
      ];
      const releaseKey = sha(canonical(files));
      const release = path.join(installation, 'releases', releaseKey);
      const manifest = {
        schemaVersion: 1,
        kind: 'release-manifest',
        releaseKey,
        convergenceHash: releaseKey,
        files,
      };
      await mkdir(path.join(release, 'bin'), { recursive: true });
      await mkdir(path.join(localAppData, 'mpx'), { recursive: true });
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(entry, loaded.buildStableNodeEntryBody());
      await writeFile(path.join(release, 'bin', 'mpx.mjs'), payload);
      await writeFile(path.join(release, 'release-manifest.json'), `${canonical(manifest)}\n`);
      await writeFile(path.join(localAppData, 'mpx', 'active-release'), `${releaseKey}\n`);
      const preload = path.join(temporary, 'registry-harness.mjs');
      await writeFile(
        preload,
        `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = (_executable, argv) => ({
  status: 0, signal: null, stderr: '',
  stdout: ['MPX_CLAUDE_EXECUTABLE', 'MPX_PI_EXECUTABLE'].includes(argv[3])
    ? '    ' + argv[3] + '    REG_SZ    C:\\\\Tools\\\\' + argv[3] + '.exe\\r\\n'
    : '',
});
syncBuiltinESMExports();
`,
      );

      await expect(
        execute(entry, localAppData, {
          env: {
            SystemRoot: path.join(temporary, 'Windows'),
            MPX_CLAUDE_EXECUTABLE: undefined,
            MPX_PI_EXECUTABLE: undefined,
          },
          nodeArgs: ['--import', pathToFileURL(preload).href],
        }),
      ).resolves.toEqual({
        code: 0,
        stdout: 'bundle-entry-hydration-sentinel\n',
        stderr: '',
      });

      await writeFile(path.join(release, 'release-manifest.json'), '{');
      await expect(execute(entry, localAppData)).resolves.toMatchObject({ code: 2, stdout: '' });

      await writeFile(path.join(release, 'release-manifest.json'), `${canonical(manifest)}\n`);
      await writeFile(
        path.join(release, 'bin', 'mpx.mjs'),
        payload.replace('sentinel', 'tampered'),
      );
      await expect(execute(entry, localAppData)).resolves.toMatchObject({ code: 2, stdout: '' });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);

  it('reports canonical source-driven drift without rewriting tracked bytes', async () => {
    const sourceName = 'apps/cli/src/main.ts';
    const bundleName = 'bin/mpx.mjs';
    const originalSource = await readFile(path.join(root, sourceName));
    const originalBundle = await readFile(path.join(root, bundleName));
    const tracked = new Map([[bundleName, originalBundle]]);

    expect(
      await checkBundles({
        sourceOverrides: new Map([
          [sourceName, Buffer.concat([originalSource, Buffer.from('\n// isolated gate change\n')])],
        ]),
        readTrackedBundle: async (name) =>
          tracked.get(name) ?? (await readFile(path.join(root, name))),
      }),
    ).toContain('BUNDLE_DRIFT: bin/mpx.mjs: tracked bundle differs from canonical source build');
    expect(tracked.get(bundleName).equals(originalBundle)).toBe(true);
  }, 30_000);

  it('distinguishes a missing tracked bundle without touching the checkout', async () => {
    const missing = 'bin/claude-gateway.js';
    const diagnostics = await checkBundles({
      readTrackedBundle: async (name) => {
        if (name === missing) {
          const failure = new Error('isolated missing artifact');
          failure.code = 'ENOENT';
          throw failure;
        }
        return readFile(path.join(root, name));
      },
    });

    expect(diagnostics).toContain(
      'BUNDLE_MISSING: bin/claude-gateway.js: tracked bundle is missing',
    );
    await expect(readFile(path.join(root, missing))).resolves.toBeInstanceOf(Buffer);
  }, 30_000);
});
