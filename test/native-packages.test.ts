import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { inspectNativePackages, RETAINED_NATIVE_PACKAGES } from '../src/native-packages.js';

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function makeAccount(root: string, versions: Record<string, string>, omit?: string): Promise<void> {
  const packages = [
    ...RETAINED_NATIVE_PACKAGES.map(name => `npm:${name}`),
    'C:/dirty-tool-display-must-not-be-inspected',
  ];
  await put(join(root, 'settings.json'), JSON.stringify({ packages, unrelatedSecretSetting: 'not-returned' }));
  for (const name of RETAINED_NATIVE_PACKAGES) {
    if (name === omit) continue;
    const packageRoot = join(root, 'npm', 'node_modules', ...name.split('/'));
    await put(join(packageRoot, 'package.json'), JSON.stringify({
      name,
      version: versions[name],
      pi: { extensions: ['./index.ts'] },
    }));
    await put(join(packageRoot, 'index.ts'), `
      import { Type } from 'typebox';
      export default function (pi: any) {
        pi.registerTool({ name: ${JSON.stringify(name.replace(/[^A-Za-z0-9]+/g, '_'))}, label: 'fixture', description: 'fixture', parameters: Type.Object({}), async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} }; } });
      }
    `);
  }
}

const versions = (web: string) => ({
  'pi-web-access': web,
  'pi-mcp-adapter': '2.32.1',
  '@juicesharp/rpiv-ask-user-question': '2.9.0',
});

test('read-only native package status resolves configured manifest load targets and reports cross-account version conflict', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mpx-native-packages-'));
  try {
    const personal = resolve(fixture, 'personal');
    const work = resolve(fixture, 'work');
    await makeAccount(personal, versions('0.28.0'));
    await makeAccount(work, versions('0.27.0'));

    const result = await inspectNativePackages([
      { account: 'personal', root: personal },
      { account: 'work', root: work },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.packages.length, 6);
    assert.deepEqual(result.conflicts.map(conflict => ({ name: conflict.packageName, versions: conflict.versions })), [
      { name: 'pi-web-access', versions: ['0.27.0', '0.28.0'] },
    ]);
    for (const entry of result.packages) {
      assert.equal(entry.status, 'ready');
      assert.equal(entry.configured, true);
      assert.equal(entry.loadTargets.length, 1);
      assert.equal(entry.loadTargets[0], join(entry.packagePath, 'index.ts'));
      assert.ok(!JSON.stringify(entry).includes('unrelatedSecretSetting'));
      assert.equal(entry.conflict, entry.packageName === 'pi-web-access');
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('object settings with disabled or filtered extensions are configured but not reported ready', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mpx-native-packages-filtered-'));
  try {
    const disabled = resolve(fixture, 'disabled');
    const filtered = resolve(fixture, 'filtered');
    await makeAccount(disabled, versions('0.28.0'));
    await makeAccount(filtered, versions('0.28.0'));
    await put(join(disabled, 'settings.json'), JSON.stringify({ packages: [
      { source: 'npm:pi-web-access', extensions: false },
      'npm:pi-mcp-adapter',
      'npm:@juicesharp/rpiv-ask-user-question',
    ] }));
    await put(join(filtered, 'settings.json'), JSON.stringify({ packages: [
      { source: 'npm:pi-web-access', extensions: [] },
      'npm:pi-mcp-adapter',
      'npm:@juicesharp/rpiv-ask-user-question',
    ] }));

    const result = await inspectNativePackages([
      { account: 'disabled', root: disabled },
      { account: 'filtered', root: filtered },
    ]);
    const web = result.packages.filter(entry => entry.packageName === 'pi-web-access');

    assert.equal(result.ok, false);
    assert.equal(web.length, 2);
    for (const entry of web) {
      assert.equal(entry.configured, true);
      assert.equal(entry.status, 'missing');
      assert.ok(entry.missing.includes('configured extension disabled/filtered'));
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('invalid null and oversized settings are handled as bounded read failures', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mpx-native-packages-settings-'));
  try {
    const account = resolve(fixture, 'account');
    await makeAccount(account, versions('0.28.0'));

    await put(join(account, 'settings.json'), 'null');
    const nullResult = await inspectNativePackages([{ account: 'fixture', root: account }]);
    assert.equal(nullResult.ok, false);
    assert.ok(nullResult.packages.every(entry => entry.missing.includes('settings.packages')));

    await put(join(account, 'settings.json'), JSON.stringify({ packages: [], padding: 'x'.repeat(1024 * 1024) }));
    const oversizedResult = await inspectNativePackages([{ account: 'fixture', root: account }]);
    assert.equal(oversizedResult.ok, false);
    assert.ok(oversizedResult.packages.every(entry => entry.missing.includes('settings.json')));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('native package status is portable for absent artifacts and requires explicit absolute roots', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mpx-native-packages-missing-'));
  try {
    const account = resolve(fixture, 'account');
    await makeAccount(account, versions('0.28.0'), 'pi-mcp-adapter');
    const result = await inspectNativePackages([{ account: 'fixture', root: account }]);
    const missing = result.packages.find(entry => entry.packageName === 'pi-mcp-adapter');
    assert.equal(result.ok, false);
    assert.equal(missing?.status, 'missing');
    assert.ok(missing?.missing.includes('package.json'));
    await assert.rejects(() => inspectNativePackages([{ account: 'fixture', root: 'relative/root' }]), /must be absolute/);
    await assert.rejects(() => inspectNativePackages([]), /explicit native package root/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('status load target supports explicit package-directory extension loading', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mpx-native-package-loader-'));
  try {
    const account = resolve(fixture, 'agent');
    const cwd = resolve(fixture, 'repo');
    await mkdir(join(cwd, '.git'), { recursive: true });
    await makeAccount(account, versions('0.28.0'));
    const inspection = await inspectNativePackages([{ account: 'fixture', root: account }]);
    const target = inspection.packages.find(entry => entry.packageName === 'pi-web-access')!;

    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: resolve(fixture, 'isolated-agent'),
      settingsManager,
      additionalExtensionPaths: [target.packagePath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();

    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.equal(loaded.extensions[0]?.resolvedPath, target.loadTargets[0]);
    assert.ok(loaded.extensions[0]?.tools.has('pi_web_access'));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
