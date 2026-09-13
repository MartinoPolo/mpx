import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { UserConfig } from '../src/contracts.js';
import { mergeClaudeHookSettings, mirrorOrcaHooks } from '../src/orca.js';

const piNames = ['orca-agent-status.ts', 'orca-prefill.ts', 'orca-titlebar-spinner.ts'] as const;
const marker = '@orca-managed-pi-extension';

async function fixture(): Promise<{ root: string; config: UserConfig }> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx2-orca-'));
  const accounts = {
    personal: { pi: path.join(root, 'personal-pi'), claude: path.join(root, 'personal-claude') },
    work: { pi: path.join(root, 'work-pi'), claude: path.join(root, 'work-claude') },
  };
  for (const roots of Object.values(accounts)) {
    for (const accountRoot of Object.values(roots)) await mkdir(accountRoot);
  }
  return { root, config: { accounts, domains: { personal: [], work: [] } } };
}

async function put(file: string, value: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

async function sourcePi(config: UserConfig, values?: Partial<Record<typeof piNames[number], Buffer>>): Promise<void> {
  for (const name of piNames) {
    await put(path.join(config.accounts.personal.pi, 'extensions', name),
      values?.[name] ?? Buffer.from(`// ${marker}\nexport const name = ${JSON.stringify(name)};\n`));
  }
}

async function sourceClaude(config: UserConfig, settings: unknown): Promise<void> {
  await put(path.join(config.accounts.personal.claude, 'settings.json'), JSON.stringify(settings));
}

async function absent(file: string): Promise<void> {
  await assert.rejects(readFile(file), { code: 'ENOENT' });
}

test('missing managed Claude source is visible rather than a healthy no-op', async () => {
  const { root, config } = await fixture();
  try {
    await sourcePi(config);
    await sourceClaude(config, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-command' }] }] } });
    const file = path.join(config.accounts.work.claude, 'settings.json');
    const before = '{"userOwned": true}\n';
    await writeFile(file, before);
    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.equal(result.ok, false);
    assert.match(result.results.find(entry => entry.harness === 'claude')?.error ?? '', /no Orca-managed/i);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.ok(result.results.filter(entry => entry.harness === 'pi').every(entry => entry.status === 'created'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preview is the default, preserves exact Pi bytes, and explicit writes are idempotent', async () => {
  const { root, config } = await fixture();
  try {
    const bytes = Object.fromEntries(piNames.map((name, index) => [name,
      Buffer.concat([Buffer.from(`// ${marker}\n${name}\n`), Buffer.from([0, 255, index])])])) as Record<typeof piNames[number], Buffer>;
    await sourcePi(config, bytes);
    await sourceClaude(config, {
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/home/me/.orca/agent-hooks/claude-hook.sh' }] }] },
      sourceOnly: 'must not copy',
    });

    const preview = await mirrorOrcaHooks(config);
    assert.equal(preview.preview, true);
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.results.map(item => item.status), ['would-create', 'would-create', 'would-create', 'would-create']);
    assert.deepEqual(await readdir(config.accounts.work.pi), []);
    assert.deepEqual(await readdir(config.accounts.work.claude), []);

    const first = await mirrorOrcaHooks(config, { preview: false });
    assert.equal(first.ok, true);
    assert.deepEqual(first.results.map(item => item.status), ['created', 'created', 'created', 'created']);
    for (const name of piNames) {
      assert.deepEqual(await readFile(path.join(config.accounts.work.pi, 'extensions', name)), bytes[name]);
    }
    const targetSettings = JSON.parse(await readFile(path.join(config.accounts.work.claude, 'settings.json'), 'utf8'));
    assert.equal(targetSettings.sourceOnly, undefined);
    assert.equal(targetSettings.hooks.Stop[0].hooks[0].command, '/home/me/.orca/agent-hooks/claude-hook.sh');

    const before = await readFile(path.join(config.accounts.work.claude, 'settings.json'));
    const second = await mirrorOrcaHooks(config, { preview: false });
    assert.equal(second.ok, true);
    assert.ok(second.results.every(item => item.status === 'unchanged'));
    assert.deepEqual(await readFile(path.join(config.accounts.work.claude, 'settings.json')), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude merger replaces only managed nested hooks and preserves target data and statusLine', async () => {
  const encoded = Buffer.from("& 'C:\\Users\\me\\.orca\\agent-hooks\\claude-hook.ps1'", 'utf16le').toString('base64');
  const source = {
    statusLine: { command: 'source status must not copy' },
    sourceOnly: { secret: 'not projected' },
    hooks: {
      SessionStart: [{
        matcher: 'source matcher', sourceUnknown: 7,
        command: '/source/unrelated-direct.sh', bash: 'source bash', powershell: 'source powershell',
        hooks: [
        { type: 'command', command: `powershell.exe -EncodedCommand ${encoded}`, timeout: 9, hookUnknown: true },
        { type: 'command', command: '/source/unrelated.sh' },
      ] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'runner', args: ['--hook', 'C:\\x\\agent-hooks\\claude-hook.cmd'] }] }],
      NoManagedSource: [{ hooks: [{ type: 'command', command: '/tmp/claude-hook.sh' }] }],
    },
  };
  const target = {
    statusLine: { type: 'command', command: '/user/status.sh', extra: 1 },
    permissions: { allow: ['Read'] },
    hooks: {
      SessionStart: [
        { matcher: 'mixed', retained: true, hooks: [
          { type: 'command', command: '/old/agent-hooks/claude-hook.sh' },
          { type: 'command', command: '/user/hook.sh', user: true },
        ] },
        { matcher: 'untouched', hooks: [{ type: 'command', command: '/other.sh' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'C:/old/agent-hooks/claude-hook.ps1' }] }],
      NoManagedSource: [{ hooks: [{ type: 'command', command: '/old/agent-hooks/claude-hook.sh' }] }],
      TargetOnly: [{ hooks: [{ type: 'command', command: '/old/agent-hooks/claude-hook.sh' }] }],
    },
  };

  const merged = mergeClaudeHookSettings(source, target) as typeof target;
  assert.deepEqual(merged.statusLine, target.statusLine);
  assert.deepEqual(merged.permissions, target.permissions);
  assert.equal((merged as Record<string, unknown>).sourceOnly, undefined);
  assert.deepEqual(merged.hooks.SessionStart[0], {
    matcher: 'mixed', retained: true,
    hooks: [{ type: 'command', command: '/user/hook.sh', user: true }],
  });
  assert.deepEqual(merged.hooks.SessionStart[1], target.hooks.SessionStart[1]);
  assert.deepEqual(merged.hooks.SessionStart[2], {
    matcher: 'source matcher', sourceUnknown: 7,
    hooks: [{ type: 'command', command: `powershell.exe -EncodedCommand ${encoded}`, timeout: 9, hookUnknown: true }],
  });
  assert.deepEqual(merged.hooks.Stop, [{
    matcher: '*', hooks: [{ type: 'command', command: 'runner', args: ['--hook', 'C:\\x\\agent-hooks\\claude-hook.cmd'] }],
  }]);
  assert.deepEqual(merged.hooks.NoManagedSource, target.hooks.NoManagedSource);
  assert.deepEqual(merged.hooks.TargetOnly, target.hooks.TargetOnly);
});

test('target-only wrapper metadata causes a preserved conflict, not silent deletion', async () => {
  const { root, config } = await fixture();
  try {
    await sourcePi(config);
    await sourceClaude(config, { hooks: { Stop: [{ hooks: [{ command: 'agent-hooks/claude-hook.cmd' }] }] } });
    const file = path.join(config.accounts.work.claude, 'settings.json');
    const before = JSON.stringify({ hooks: { Stop: [{ matcher: 'user-specific', userMetadata: true, hooks: [{ command: '/old/agent-hooks/claude-hook.sh' }] }] } });
    await writeFile(file, before);
    for (const preview of [true, false]) {
      const result = await mirrorOrcaHooks(config, { preview });
      assert.equal(result.results.find(entry => entry.harness === 'claude')?.status, 'conflict');
      assert.equal(result.ok, false);
      assert.equal(await readFile(file, 'utf8'), before);
    }
    // Metadata also present in the replacement is not lost and remains idempotent.
    const same = { hooks: { Stop: [{ matcher: '*', userMetadata: true, hooks: [{ command: 'agent-hooks/claude-hook.cmd' }] }] } };
    assert.deepEqual(mergeClaudeHookSettings(same, same), same);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('matcher keeps native case and path-needle semantics and ignores direct commands', () => {
  const target = { hooks: { Stop: [{
    command: '/old/agent-hooks/claude-hook.sh',
    hooks: [{ type: 'command', command: '/old/agent-hooks/claude-hook.sh' }],
  }] } };
  const merged = mergeClaudeHookSettings({ hooks: { Stop: [{ hooks: [
    { type: 'command', command: '/x/Agent-Hooks/claude-hook.sh' },
    { type: 'command', command: '/x/claude-hook.sh' },
    { type: 'command', command: '/x/agent-hooks/claude-hook.ps1' },
  ] }] } }, target) as typeof target;
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.Stop[0]!.command, '/old/agent-hooks/claude-hook.sh');
  assert.deepEqual(merged.hooks.Stop[0]!.hooks, undefined);
  assert.deepEqual(merged.hooks.Stop[1]!.hooks, [{ type: 'command', command: '/x/agent-hooks/claude-hook.ps1' }]);
});

test('marked Pi files update, identical files stay put, and user-owned targets conflict', async () => {
  const { root, config } = await fixture();
  try {
    await sourcePi(config);
    await sourceClaude(config, {});
    const extensions = path.join(config.accounts.work.pi, 'extensions');
    await put(path.join(extensions, piNames[0]), 'user extension');
    await put(path.join(extensions, piNames[1]), `// ${marker}\nstale`);
    await put(path.join(extensions, piNames[2]), await readFile(path.join(config.accounts.personal.pi, 'extensions', piNames[2])));
    const userBefore = await readFile(path.join(extensions, piNames[0]));

    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.equal(result.ok, false);
    assert.deepEqual(result.results.slice(0, 3).map(item => item.status), ['conflict', 'updated', 'unchanged']);
    assert.deepEqual(await readFile(path.join(extensions, piNames[0])), userBefore);
    assert.deepEqual(await readFile(path.join(extensions, piNames[1])),
      await readFile(path.join(config.accounts.personal.pi, 'extensions', piNames[1])));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed Claude settings are visible and preserved while Pi succeeds', async () => {
  const { root, config } = await fixture();
  try {
    await sourcePi(config);
    await sourceClaude(config, { hooks: { Stop: [{ hooks: 'not-an-array' }] } });
    const targetFile = path.join(config.accounts.work.claude, 'settings.json');
    const targetBytes = Buffer.from('{"statusLine":{"command":"user"}}');
    await writeFile(targetFile, targetBytes);

    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.ok(result.results.slice(0, 3).every(item => item.status === 'created'));
    assert.equal(result.results[3]!.status, 'failed');
    assert.match(result.results[3]!.error ?? '', /structure.*malformed/i);
    assert.deepEqual(await readFile(targetFile), targetBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a linked extensions ancestor is rejected without escaping the configured root', async () => {
  const { root, config } = await fixture();
  try {
    await sourcePi(config);
    await sourceClaude(config, { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/agent-hooks/claude-hook.sh' }] }] } });
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel'), 'outside bytes');
    await symlink(outside, path.join(config.accounts.work.pi, 'extensions'), 'junction');

    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.ok(result.results.slice(0, 3).every(item => item.status === 'failed'));
    assert.equal(result.results[3]!.status, 'created');
    assert.deepEqual(await readdir(outside), ['sentinel']);
    assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'outside bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing account roots are not created and do not block the other harness', async () => {
  const { root, config } = await fixture();
  try {
    await sourcePi(config);
    await sourceClaude(config, { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/agent-hooks/claude-hook.sh' }] }] } });
    const missingRoot = config.accounts.work.pi;
    await rm(missingRoot, { recursive: true });

    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.ok(result.results.slice(0, 3).every(item => item.status === 'failed'));
    assert.equal(result.results[3]!.status, 'created');
    await absent(missingRoot);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing and unmarked Pi sources fail independently of a healthy file and Claude', async () => {
  const { root, config } = await fixture();
  try {
    await put(path.join(config.accounts.personal.pi, 'extensions', piNames[1]), '// user source');
    await put(path.join(config.accounts.personal.pi, 'extensions', piNames[2]), `// ${marker}\nhealthy`);
    await sourceClaude(config, { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/agent-hooks/claude-hook.sh' }] }] } });

    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.deepEqual(result.results.map(item => item.status), ['failed', 'failed', 'created', 'created']);
    await absent(path.join(config.accounts.work.pi, 'extensions', piNames[0]));
    await absent(path.join(config.accounts.work.pi, 'extensions', piNames[1]));
    assert.equal(await readFile(path.join(config.accounts.work.pi, 'extensions', piNames[2]), 'utf8'), `// ${marker}\nhealthy`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const managedSettings = (matcher = '*') => ({ hooks: { Stop: [{ matcher, hooks: [
  { type: 'command', command: '/x/agent-hooks/claude-hook.sh' },
] }] } });

test('Claude JSON uses fatal UTF-8 decoding but accepts a legitimate replacement character', async () => {
  for (const invalidSide of ['source', 'target'] as const) {
    const { root, config } = await fixture();
    try {
      const sourceFile = path.join(config.accounts.personal.claude, 'settings.json');
      const targetFile = path.join(config.accounts.work.claude, 'settings.json');
      const invalid = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
      const targetBefore = invalidSide === 'target' ? invalid : Buffer.from('{"keep":true}');
      await put(sourceFile, invalidSide === 'source' ? invalid : JSON.stringify(managedSettings()));
      await put(targetFile, targetBefore);

      const result = await mirrorOrcaHooks(config, { preview: false });
      assert.equal(result.results[3]!.status, 'failed');
      assert.deepEqual(await readFile(targetFile), targetBefore);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  const { root, config } = await fixture();
  try {
    await sourceClaude(config, managedSettings('valid-\uFFFD-character'));
    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.equal(result.results[3]!.status, 'created');
    const written = JSON.parse(await readFile(path.join(config.accounts.work.claude, 'settings.json'), 'utf8'));
    assert.equal(written.hooks.Stop[0].matcher, 'valid-\uFFFD-character');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an oversized merged Claude document is rejected without changing the target', async () => {
  const { root, config } = await fixture();
  try {
    await sourceClaude(config, managedSettings('s'.repeat(600_000)));
    const targetFile = path.join(config.accounts.work.claude, 'settings.json');
    const targetBefore = Buffer.from(JSON.stringify({ retained: 't'.repeat(600_000) }));
    await put(targetFile, targetBefore);

    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.equal(result.results[3]!.status, 'failed');
    assert.deepEqual(await readFile(targetFile), targetBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed temporary write is closed and removed', async t => {
  const { root, config } = await fixture();
  try {
    const failingBytes = Buffer.from(`// ${marker}\nonly-this-buffer-fails\n`);
    await sourcePi(config, { [piNames[0]]: failingBytes });
    for (const name of piNames.slice(1)) {
      await put(path.join(config.accounts.work.pi, 'extensions', name),
        await readFile(path.join(config.accounts.personal.pi, 'extensions', name)));
    }
    await sourceClaude(config, {});
    const probe = await open(path.join(root, 'file-handle-probe'), 'w');
    const methods = Object.getPrototypeOf(probe) as { writeFile: FileHandle['writeFile'] };
    await probe.close();
    const original = methods.writeFile;
    t.mock.method(methods, 'writeFile', async function(
      this: FileHandle,
      data: Parameters<FileHandle['writeFile']>[0],
      options?: Parameters<FileHandle['writeFile']>[1],
    ) {
      if (Buffer.isBuffer(data) && data.equals(failingBytes)) throw new Error('injected write failure');
      await original.call(this, data, options);
    });

    const result = await mirrorOrcaHooks(config, { preview: false });
    assert.equal(result.results[0]!.status, 'failed');
    const entries = await readdir(path.join(config.accounts.work.pi, 'extensions'));
    assert.equal(entries.some(name => name.startsWith('.orca-mirror-')), false);
    await absent(path.join(config.accounts.work.pi, 'extensions', piNames[0]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file observation changes on source and target boundaries are rejected', async t => {
  const sourceChanging = Buffer.from(JSON.stringify(managedSettings('source-observation-' + 's'.repeat(137))));
  const targetChanging = Buffer.from(JSON.stringify({ keep: 'target-observation-' + 't'.repeat(251) }));
  const changedSizes = new Set([sourceChanging.length, targetChanging.length]);
  const counts = new WeakMap<FileHandle, number>();
  const setup = await fixture();
  const probe = await open(path.join(setup.root, 'file-handle-probe'), 'w');
  const methods = Object.getPrototypeOf(probe) as { stat: () => Promise<Stats> };
  await probe.close();
  const original = methods.stat;
  t.mock.method(methods, 'stat', async function(this: FileHandle) {
    const observed = await original.call(this);
    if (!changedSizes.has(observed.size)) return observed;
    const count = (counts.get(this) ?? 0) + 1;
    counts.set(this, count);
    return count === 2 ? new Proxy(observed, {
      get(target, property, receiver) {
        return property === 'mtimeMs' ? target.mtimeMs + 1 : Reflect.get(target, property, receiver);
      },
    }) : observed;
  });

  try {
    await put(path.join(setup.config.accounts.personal.claude, 'settings.json'), sourceChanging);
    const firstTarget = path.join(setup.config.accounts.work.claude, 'settings.json');
    const firstBefore = Buffer.from('{"first":true}');
    await put(firstTarget, firstBefore);
    const sourceResult = await mirrorOrcaHooks(setup.config, { preview: false });
    assert.equal(sourceResult.results[3]!.status, 'failed');
    assert.deepEqual(await readFile(firstTarget), firstBefore);
  } finally { await rm(setup.root, { recursive: true, force: true }); }

  const second = await fixture();
  try {
    await sourceClaude(second.config, managedSettings());
    const targetFile = path.join(second.config.accounts.work.claude, 'settings.json');
    await put(targetFile, targetChanging);
    const targetResult = await mirrorOrcaHooks(second.config, { preview: false });
    assert.equal(targetResult.results[3]!.status, 'failed');
    assert.deepEqual(await readFile(targetFile), targetChanging);
  } finally { await rm(second.root, { recursive: true, force: true }); }
});
