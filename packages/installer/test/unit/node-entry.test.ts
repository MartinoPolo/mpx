import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStrictJson } from '@mpx/core';
import {
  canonicalJson,
  installerDigest,
  parseReleaseManifestV1,
  type ReleaseFileV1,
} from '../../src/immutable-core.js';
import {
  buildStableNodeEntryBody,
  buildStableSelectorBody,
} from '../../src/windows-integration.js';
import {
  maliciousReleaseManifestBodies,
  releasePayload,
  validReleaseManifest,
} from '../fixtures/release-manifest.js';

const roots: string[] = [];

const sha256 = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');

function releaseManifest(files: Readonly<Record<string, string | Buffer>>) {
  const evidence: ReleaseFileV1[] = Object.entries(files)
    .map(([file, body]) => ({ path: file, bytes: Buffer.byteLength(body), sha256: sha256(body) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const releaseKey = installerDigest(evidence);
  return {
    schemaVersion: 1 as const,
    kind: 'release-manifest' as const,
    releaseKey,
    convergenceHash: releaseKey,
    files: evidence,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-node-entry-'));
  roots.push(root);
  const installation = path.join(root, 'installation');
  const localAppData = path.join(root, 'local');
  const entry = path.join(installation, 'bin', 'mpx-node.mjs');
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(path.join(localAppData, 'mpx'), { recursive: true });
  await writeFile(entry, buildStableNodeEntryBody());
  return { root, installation, localAppData, entry };
}

async function selectRelease(localAppData: string, releaseKey: string) {
  await writeFile(path.join(localAppData, 'mpx', 'active-release'), `${releaseKey}\n`);
}

async function installRelease(
  installation: string,
  localAppData: string,
  files: Readonly<Record<string, string | Buffer>>,
) {
  const manifest = releaseManifest(files);
  const release = path.join(installation, 'releases', manifest.releaseKey);
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(release, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await writeFile(path.join(release, 'release-manifest.json'), `${canonicalJson(manifest)}\n`);
  await selectRelease(localAppData, manifest.releaseKey);
  return { manifest, release, selected: path.join(release, 'bin', 'mpx.mjs') };
}

function execute(
  entry: string,
  localAppData: string,
  argv: string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly nodeArgs?: readonly string[] } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), entry, ...argv], {
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        MPX_APPS: path.join(localAppData, 'decoy'),
        ...options.env,
      },
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
}

async function writePreload(root: string, body: string) {
  const preload = path.join(root, 'preload.mjs');
  await writeFile(preload, body);
  return preload;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('stable argv-only Node entry', () => {
  it('contains only statically authored validation code without serialized function bodies', () => {
    const body = buildStableNodeEntryBody();

    expect(body).toContain('const manifestValidation = (() => {');
    expect(body).not.toMatch(/Function\.prototype\.toString|\.toString\(\)/u);
    expect(body).not.toContain('releaseManifestValidationSource');
  });

  it('hydrates only missing installer-owned absolute paths through exact argv before release import', async () => {
    const { root, installation, localAppData, entry } = await fixture();
    await installRelease(installation, localAppData, {
      'bin/mpx.mjs': `console.log(JSON.stringify({
  claude: process.env.MPX_CLAUDE_EXECUTABLE === 'C:\\\\Tools\\\\claude.exe',
  pi: process.env.MPX_PI_EXECUTABLE === 'C:\\\\Tools\\\\pi.exe',
  explicit: process.env.MPX_PROJECTS === 'C:\\\\Explicit',
  secret: process.env.MPX_API_TOKEN,
}));\n`,
    });
    const calls = path.join(root, 'registry-calls.json');
    const systemRoot = path.join(root, 'Windows');
    const preload = await writePreload(
      root,
      `import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const values = {
  MPX_CLAUDE_EXECUTABLE: 'C:\\\\Tools\\\\claude.exe',
  MPX_PI_EXECUTABLE: 'C:\\\\Tools\\\\pi.exe',
  MPX_PROJECTS: 'C:\\\\RegistryMustNotWin',
};
const calls = [];
childProcess.spawnSync = (executable, argv, options) => {
  calls.push({ executable, argv, options });
  const name = argv[3];
  const value = values[name];
  return value === undefined
    ? { status: 1, signal: null, stdout: '', stderr: '' }
    : { status: 0, signal: null, stdout: 'HKEY_CURRENT_USER\\\\Environment\\r\\n    ' + name + '    REG_SZ    ' + value + '\\r\\n', stderr: '' };
};
syncBuiltinESMExports();
process.on('exit', () => writeFileSync(process.env.MPX_TEST_CALLS, JSON.stringify(calls)));
`,
    );

    const result = await execute(entry, localAppData, [], {
      env: {
        SystemRoot: systemRoot,
        MPX_PROJECTS: 'C:\\Explicit',
        MPX_CLAUDE_EXECUTABLE: undefined,
        MPX_PI_EXECUTABLE: undefined,
        MPX_API_TOKEN: undefined,
        MPX_TEST_CALLS: calls,
      },
      nodeArgs: ['--import', pathToFileURL(preload).href],
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ claude: true, pi: true, explicit: true });
    const invocations = JSON.parse(
      await (await import('node:fs/promises')).readFile(calls, 'utf8'),
    );
    expect(invocations.map((call: { argv: string[] }) => call.argv[3])).not.toContain(
      'MPX_PROJECTS',
    );
    expect(invocations.map((call: { argv: string[] }) => call.argv[3])).not.toContain(
      'MPX_API_TOKEN',
    );
    expect(
      invocations.every((call: { executable: string }) => path.isAbsolute(call.executable)),
    ).toBe(true);
    expect(
      invocations.every(
        (call: { argv: string[] }) =>
          call.argv.slice(0, 3).join('|') === 'query|HKCU\\Environment|/v',
      ),
    ).toBe(true);
    expect(
      invocations.every(
        (call: { options: { shell: boolean; timeout: number; maxBuffer: number } }) =>
          call.options.shell === false && call.options.timeout > 0 && call.options.maxBuffer > 0,
      ),
    ).toBe(true);
  });

  it('leaves failed, malformed, duplicate, empty, control, and non-absolute registry values missing', async () => {
    const { root, installation, localAppData, entry } = await fixture();
    await installRelease(installation, localAppData, {
      'bin/mpx.mjs': `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([
        'MPX_APPS',
        'MPX_PROJECTS',
        'MPX_WORK',
        'MPX_CLONED',
        'MPX_ONEDRIVE',
        'MPX_AI_GENERATED',
        'MPX_OBSIDIAN_VAULT',
        'MPX_NODE_EXECUTABLE',
        'MPX_PI_EXECUTABLE',
        'MPX_CLAUDE_EXECUTABLE',
      ])}.map((name) => [name, process.env[name]]))));\n`,
    });
    const preload = await writePreload(
      root,
      `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const line = (name, type, value) => '    ' + name + '    ' + type + '    ' + value + '\\r\\n';
childProcess.spawnSync = (_executable, argv) => {
  const name = argv[3];
  const outputs = {
    MPX_APPS: line(name, 'REG_SZ', 'relative'),
    MPX_PROJECTS: line(name, 'REG_SZ', 'C:\\\\One') + line(name, 'REG_SZ', 'C:\\\\Two'),
    MPX_WORK: line('MPX_OTHER', 'REG_SZ', 'C:\\\\Other'),
    MPX_CLONED: line(name, 'REG_DWORD', 'C:\\\\WrongType'),
    MPX_ONEDRIVE: line(name, 'REG_SZ', ' C:\\\\Leading'),
    MPX_AI_GENERATED: line(name, 'REG_SZ', 'C:\\\\Trailing '),
    MPX_OBSIDIAN_VAULT: line(name, 'REG_SZ', 'C:\\\\Control\\u0007'),
    MPX_NODE_EXECUTABLE: line(name, 'REG_SZ', ''),
    MPX_PI_EXECUTABLE: line(name, 'REG_SZ', 'C:\\\\First') + line(name, 'REG_EXPAND_SZ', 'C:\\\\Second'),
  };
  if (name === 'MPX_CLAUDE_EXECUTABLE') return { status: null, signal: null, error: new Error('maxBuffer'), stdout: 'x'.repeat(65537), stderr: '' };
  return { status: name === 'MPX_WORK' ? 1 : 0, signal: null, stdout: outputs[name], stderr: '' };
};
syncBuiltinESMExports();
`,
    );
    const missing = Object.fromEntries(
      [
        'MPX_APPS',
        'MPX_PROJECTS',
        'MPX_WORK',
        'MPX_CLONED',
        'MPX_ONEDRIVE',
        'MPX_AI_GENERATED',
        'MPX_OBSIDIAN_VAULT',
        'MPX_NODE_EXECUTABLE',
        'MPX_PI_EXECUTABLE',
        'MPX_CLAUDE_EXECUTABLE',
      ].map((name) => [name, undefined]),
    );

    const result = await execute(entry, localAppData, [], {
      env: { ...missing, SystemRoot: path.join(root, 'Windows') },
      nodeArgs: ['--import', pathToFileURL(preload).href],
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it('accepts the shared canonical manifest fixture in both immutable-core and the standalone entry', async () => {
    const { installation, localAppData, entry } = await fixture();
    const release = path.join(installation, 'releases', validReleaseManifest.releaseKey);
    await mkdir(path.join(release, 'bin'), { recursive: true });
    await writeFile(path.join(release, 'bin', 'mpx.mjs'), releasePayload);
    await writeFile(
      path.join(release, 'release-manifest.json'),
      `${canonicalJson(validReleaseManifest)}\n`,
    );
    await selectRelease(localAppData, validReleaseManifest.releaseKey);

    expect(parseReleaseManifestV1(parseStrictJson(canonicalJson(validReleaseManifest)))).toEqual(
      validReleaseManifest,
    );
    await expect(execute(entry, localAppData, [])).resolves.toMatchObject({
      code: 0,
      stdout: 'manifest-fixture-sentinel\n',
    });
  });

  it.each(maliciousReleaseManifestBodies)(
    'rejects a shared malicious manifest fixture in both immutable-core and the standalone entry: %s',
    async (manifestBody) => {
      const { installation, localAppData, entry } = await fixture();
      const release = path.join(installation, 'releases', validReleaseManifest.releaseKey);
      await mkdir(path.join(release, 'bin'), { recursive: true });
      await writeFile(path.join(release, 'bin', 'mpx.mjs'), releasePayload);
      await writeFile(path.join(release, 'release-manifest.json'), `${manifestBody}\n`);
      await selectRelease(localAppData, validReleaseManifest.releaseKey);

      expect(() => parseReleaseManifestV1(parseStrictJson(manifestBody))).toThrow();
      await expect(execute(entry, localAppData, [])).resolves.toMatchObject({
        code: 2,
        stdout: '',
      });
    },
  );

  it('executes authenticated captured bytes when the pathname is replaced at module-load boundary', async () => {
    const { root, installation, localAppData, entry } = await fixture();
    const authenticated = "console.log('authenticated');\n";
    const { selected } = await installRelease(installation, localAppData, {
      'bin/mpx.mjs': authenticated,
    });
    const replacement = path.join(root, 'replacement.mjs');
    await writeFile(replacement, "console.log('replacement');\n");
    const preload = await writePreload(
      root,
      `import { registerHooks } from 'node:module';
import { renameSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const target = pathToFileURL(process.env.MPX_TEST_TARGET).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === target) {
      rmSync(process.env.MPX_TEST_TARGET);
      renameSync(process.env.MPX_TEST_REPLACEMENT, process.env.MPX_TEST_TARGET);
    }
    return nextResolve(specifier, context);
  },
});
`,
    );

    const result = await execute(entry, localAppData, [], {
      env: { MPX_TEST_REPLACEMENT: replacement, MPX_TEST_TARGET: selected },
      nodeArgs: ['--import', pathToFileURL(preload).href],
    });

    expect(result).toMatchObject({ code: 0, stdout: 'authenticated\n', stderr: '' });
  });

  it.skipIf(process.platform !== 'win32')(
    'executes the generated cmd.exe selector without injection and preserves tricky argv',
    async () => {
      const { root, installation, localAppData, entry } = await fixture();
      const { selected } = await installRelease(installation, localAppData, {
        'bin/mpx.mjs':
          'console.log(JSON.stringify({ argv: process.argv, entry: import.meta.url }));\n',
      });
      const selector = path.join(path.dirname(entry), 'mpx.cmd');
      const injectionMarker = path.join(root, 'injected.txt');
      await writeFile(selector, buildStableSelectorBody());
      const command = `call "${selector}" "" "space value" """quoted""" "a&b" "a|b" "a<b" "a>b" "& echo injected>${injectionMarker}"`;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', `"${command}"`],
            {
              windowsVerbatimArguments: true,
              env: {
                ...process.env,
                LOCALAPPDATA: localAppData,
                MPX_NODE_EXECUTABLE: process.execPath,
              },
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
        },
      );

      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toEqual({
        argv: [
          process.execPath,
          selected,
          '',
          'space value',
          '"quoted"',
          'a&b',
          'a|b',
          'a<b',
          'a>b',
          `& echo injected>${injectionMarker}`,
        ],
        entry: pathToFileURL(selected).href,
      });
      await expect(
        import('node:fs/promises').then(({ access }) => access(injectionMarker)),
      ).rejects.toThrow();
    },
  );

  it('loads the selected immutable CLI self-relatively and preserves exact argv boundaries', async () => {
    const { installation, localAppData, entry } = await fixture();
    const { selected } = await installRelease(installation, localAppData, {
      'bin/mpx.mjs':
        'console.log(JSON.stringify({ argv: process.argv, entry: import.meta.url }));\n',
    });

    const argv = ['space value', '"quoted"', '&|<>', '', 'line\nbreak'];
    const result = await execute(entry, localAppData, argv);

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(buildStableNodeEntryBody()).not.toMatch(/\bexecSync\b|\beval\b/u);
    expect(buildStableNodeEntryBody()).toContain('shell: false');
    expect(JSON.parse(result.stdout)).toEqual({
      argv: [process.execPath, selected, ...argv],
      entry: new URL(`file://${selected}`).href,
    });
  });

  it.each([
    'A'.repeat(64),
    `${'a'.repeat(63)}g`,
    `../${'a'.repeat(64)}`,
    `${'a'.repeat(64)} extra`,
  ])('rejects malformed selector content without importing a target: %s', async (selector) => {
    const { localAppData, entry } = await fixture();
    await writeFile(path.join(localAppData, 'mpx', 'active-release'), selector);
    const result = await execute(entry, localAppData, []);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  });

  it('rejects a missing or non-regular selector', async () => {
    const { localAppData, entry } = await fixture();
    const selector = path.join(localAppData, 'mpx', 'active-release');
    expect((await execute(entry, localAppData, [])).code).toBe(2);
    await mkdir(selector);
    expect((await execute(entry, localAppData, [])).code).toBe(2);
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a junction in the selector ancestry below the trusted volume root',
    async () => {
      const { root, localAppData, entry } = await fixture();
      const selectorParent = path.join(localAppData, 'mpx');
      const foreignParent = path.join(root, 'foreign-selector-parent');
      await mkdir(foreignParent);
      await writeFile(path.join(foreignParent, 'active-release'), `${'a'.repeat(64)}\n`);
      await rm(selectorParent, { recursive: true });
      await symlink(foreignParent, selectorParent, 'junction');

      expect((await execute(entry, localAppData, [])).code).toBe(2);
    },
  );

  it('rejects a symlink selector', async () => {
    const { root, localAppData, entry } = await fixture();
    const selector = path.join(localAppData, 'mpx', 'active-release');
    const foreign = path.join(root, 'foreign-selector');
    await writeFile(foreign, 'a'.repeat(64));
    await symlink(foreign, selector, 'file');

    expect((await execute(entry, localAppData, [])).code).toBe(2);
  });

  it('rejects a missing or non-regular selected target', async () => {
    const { installation, localAppData, entry } = await fixture();
    const releaseKey = 'a'.repeat(64);
    await selectRelease(localAppData, releaseKey);
    const target = path.join(installation, 'releases', releaseKey, 'bin', 'mpx.mjs');
    expect((await execute(entry, localAppData, [])).code).toBe(2);
    await mkdir(target, { recursive: true });
    expect((await execute(entry, localAppData, [])).code).toBe(2);
  });

  it('rejects a symbolic-link ancestor in the immutable target path', async () => {
    const { root, installation, localAppData, entry } = await fixture();
    const body = "console.log('unsafe');\n";
    const manifest = releaseManifest({ 'bin/mpx.mjs': body });
    const foreignRelease = path.join(root, 'foreign-release');
    await mkdir(path.join(foreignRelease, 'bin'), { recursive: true });
    await writeFile(path.join(foreignRelease, 'bin', 'mpx.mjs'), body);
    await writeFile(
      path.join(foreignRelease, 'release-manifest.json'),
      `${canonicalJson(manifest)}\n`,
    );
    await mkdir(path.join(installation, 'releases'), { recursive: true });
    await symlink(
      foreignRelease,
      path.join(installation, 'releases', manifest.releaseKey),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await selectRelease(localAppData, manifest.releaseKey);

    const result = await execute(entry, localAppData, []);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  });

  it('rejects a symlink selected target', async () => {
    const { root, installation, localAppData, entry } = await fixture();
    const body = "console.log('unsafe');\n";
    const manifest = releaseManifest({ 'bin/mpx.mjs': body });
    const release = path.join(installation, 'releases', manifest.releaseKey);
    const target = path.join(release, 'bin', 'mpx.mjs');
    const foreign = path.join(root, 'foreign.mjs');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(foreign, body);
    await symlink(foreign, target, 'file');
    await writeFile(path.join(release, 'release-manifest.json'), `${canonicalJson(manifest)}\n`);
    await selectRelease(localAppData, manifest.releaseKey);

    const result = await execute(entry, localAppData, []);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['same-size', "console.log('tamperd');\n"],
    ['size-changing', "console.log('tampered and longer');\n"],
  ])('rejects %s target tampering present before capture', async (_label, tampered) => {
    const { installation, localAppData, entry } = await fixture();
    const { selected } = await installRelease(installation, localAppData, {
      'bin/mpx.mjs': "console.log('trusted');\n",
    });
    await writeFile(selected, tampered);

    expect(await execute(entry, localAppData, [])).toMatchObject({ code: 2, stdout: '' });
  });

  it.each([
    [
      'missing manifest',
      async (release: string) => rm(path.join(release, 'release-manifest.json')),
    ],
    [
      'malformed manifest',
      async (release: string) => writeFile(path.join(release, 'release-manifest.json'), '{'),
    ],
    [
      'noncanonical manifest',
      async (release: string, manifest: ReturnType<typeof releaseManifest>) =>
        writeFile(path.join(release, 'release-manifest.json'), JSON.stringify(manifest, null, 2)),
    ],
    [
      'wrong release key',
      async (release: string, manifest: ReturnType<typeof releaseManifest>) =>
        writeFile(
          path.join(release, 'release-manifest.json'),
          `${canonicalJson({ ...manifest, releaseKey: 'a'.repeat(64) })}\n`,
        ),
    ],
    [
      'duplicate path',
      async (release: string, manifest: ReturnType<typeof releaseManifest>) =>
        writeFile(
          path.join(release, 'release-manifest.json'),
          `${canonicalJson({ ...manifest, files: [...manifest.files, manifest.files[0]] })}\n`,
        ),
    ],
    [
      'wrong digest',
      async (release: string, manifest: ReturnType<typeof releaseManifest>) =>
        writeFile(
          path.join(release, 'release-manifest.json'),
          `${canonicalJson({
            ...manifest,
            files: manifest.files.map((file) => ({ ...file, sha256: 'a'.repeat(64) })),
          })}\n`,
        ),
    ],
  ])('fails closed for %s binding', async (_label, mutate) => {
    const { installation, localAppData, entry } = await fixture();
    const { release, manifest } = await installRelease(installation, localAppData, {
      'bin/mpx.mjs': "console.log('must not run');\n",
    });
    await mutate(release, manifest);

    expect(await execute(entry, localAppData, [])).toMatchObject({ code: 2, stdout: '' });
  });

  it('rejects a symlink release manifest', async () => {
    const { root, installation, localAppData, entry } = await fixture();
    const installed = await installRelease(installation, localAppData, {
      'bin/mpx.mjs': "console.log('must not run');\n",
    });
    const manifestPath = path.join(installed.release, 'release-manifest.json');
    const foreign = path.join(root, 'manifest.json');
    await writeFile(foreign, `${canonicalJson(installed.manifest)}\n`);
    await rm(manifestPath);
    await symlink(foreign, manifestPath, 'file');

    expect(await execute(entry, localAppData, [])).toMatchObject({ code: 2, stdout: '' });
  });

  it('delegates unrelated imports and deregisters its hooks after the selected import', async () => {
    const { root, installation, localAppData, entry } = await fixture();
    await installRelease(installation, localAppData, {
      'bin/dependency.mjs': "export default 'delegated';\n",
      'bin/mpx.mjs':
        "import value from './dependency.mjs'; globalThis.__mpxValue = value; console.log(value);\n",
    });
    const preload = await writePreload(
      root,
      `import Module, { syncBuiltinESMExports } from 'node:module';
const original = Module.registerHooks;
let delegatedResolve = 0;
let delegatedLoad = 0;
let deregistered = false;
Module.registerHooks = (options) => {
  const registration = original({
    resolve(specifier, context, nextResolve) {
      return options.resolve(specifier, context, (...args) => { delegatedResolve++; return nextResolve(...args); });
    },
    load(url, context, nextLoad) {
      return options.load(url, context, (...args) => { delegatedLoad++; return nextLoad(...args); });
    },
  });
  return { deregister() { deregistered = true; registration.deregister(); } };
};
syncBuiltinESMExports();
process.on('beforeExit', () => console.log(JSON.stringify({ delegatedResolve, delegatedLoad, deregistered, value: globalThis.__mpxValue })));
`,
    );

    const result = await execute(entry, localAppData, [], {
      nodeArgs: ['--import', pathToFileURL(preload).href],
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual([
      'delegated',
      JSON.stringify({
        delegatedResolve: 1,
        delegatedLoad: 1,
        deregistered: true,
        value: 'delegated',
      }),
    ]);
  });

  it('selects a newly activated immutable release on each invocation of the same stable entry', async () => {
    const { installation, localAppData, entry } = await fixture();
    const first = await installRelease(installation, localAppData, {
      'bin/mpx.mjs': "console.log('first');\n",
    });
    const second = await installRelease(installation, localAppData, {
      'bin/mpx.mjs': "console.log('second');\n",
    });

    await selectRelease(localAppData, first.manifest.releaseKey);
    expect((await execute(entry, localAppData, [])).stdout.trim()).toBe('first');
    await selectRelease(localAppData, second.manifest.releaseKey);
    expect((await execute(entry, localAppData, [])).stdout.trim()).toBe('second');
  });
});
