import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { readFooterCompactionSettings } from '../src/pi-footer-settings.js';

async function fixture(): Promise<{ root: string; cwd: string; agentDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-footer-settings-'));
  const cwd = path.join(root, 'project');
  const agentDir = path.join(root, 'selected-account');
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  return { root, cwd, agentDir };
}

async function put(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

test('missing settings use native compaction defaults without creating settings roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-footer-settings-missing-'));
  const cwd = path.join(root, 'missing-project');
  const agentDir = path.join(root, 'missing-account');
  try {
    const native = SettingsManager.inMemory().getCompactionSettings();
    assert.deepEqual(await readFooterCompactionSettings(cwd, agentDir), {
      enabled: native.enabled,
      reserveTokens: native.reserveTokens,
    });
    await assert.rejects(stat(agentDir), { code: 'ENOENT' });
    await assert.rejects(stat(cwd), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project compaction keys override global keys while unrelated settings are ignored', async () => {
  const { root, cwd, agentDir } = await fixture();
  try {
    await put(path.join(agentDir, 'settings.json'), {
      theme: 'global-theme', compaction: { enabled: false, reserveTokens: 123, keepRecentTokens: 'ignored' },
    });
    await put(path.join(cwd, '.pi', 'settings.json'), {
      defaultModel: 42, compaction: { reserveTokens: 456 },
    });
    assert.deepEqual(await readFooterCompactionSettings(cwd, agentDir), { enabled: false, reserveTokens: 456 });
    await put(path.join(cwd, '.pi', 'settings.json'), { compaction: { enabled: true } });
    assert.deepEqual(await readFooterCompactionSettings(cwd, agentDir), { enabled: true, reserveTokens: 123 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected account directory is read instead of a decoy account', async () => {
  const { root, cwd, agentDir } = await fixture();
  const decoy = path.join(root, '.pi', 'agent');
  try {
    await put(path.join(agentDir, 'settings.json'), { compaction: { reserveTokens: 777 } });
    await put(path.join(decoy, 'settings.json'), { compaction: { reserveTokens: 999 } });
    const native = SettingsManager.inMemory().getCompactionSettings();
    assert.deepEqual(await readFooterCompactionSettings(cwd, agentDir), { enabled: native.enabled, reserveTokens: 777 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('disabled compaction and a zero reserve are preserved', async () => {
  const { root, cwd, agentDir } = await fixture();
  try {
    await put(path.join(agentDir, 'settings.json'), { compaction: { enabled: false, reserveTokens: 0 } });
    assert.deepEqual(await readFooterCompactionSettings(cwd, agentDir), { enabled: false, reserveTokens: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed, non-object, invalid compaction values, and oversized files fail explicitly', async () => {
  const invalid: unknown[] = [
    '{', [], null, { compaction: null }, { compaction: { enabled: 'yes' } },
    { compaction: { reserveTokens: -1 } }, { compaction: { reserveTokens: 1.5 } },
    { compaction: { reserveTokens: Number.POSITIVE_INFINITY } },
  ];
  for (const value of invalid) {
    const { root, cwd, agentDir } = await fixture();
    try {
      await put(path.join(agentDir, 'settings.json'), value);
      assert.equal(await readFooterCompactionSettings(cwd, agentDir), undefined, JSON.stringify(value));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const { root, cwd, agentDir } = await fixture();
  try {
    await writeFile(path.join(agentDir, 'settings.json'), `${' '.repeat(128 * 1024)}{}`);
    assert.equal(await readFooterCompactionSettings(cwd, agentDir), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reads settings without changing their bytes', async () => {
  const { root, cwd, agentDir } = await fixture();
  const globalPath = path.join(agentDir, 'settings.json');
  const projectPath = path.join(cwd, '.pi', 'settings.json');
  const globalBytes = Buffer.from('{\n  "compaction": { "reserveTokens": 321 }\n}\n');
  const projectBytes = Buffer.from('{ "unrelated": true }\n');
  try {
    await put(globalPath, globalBytes.toString());
    await put(projectPath, projectBytes.toString());
    await readFooterCompactionSettings(cwd, agentDir);
    assert.deepEqual(await readFile(globalPath), globalBytes);
    assert.deepEqual(await readFile(projectPath), projectBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
