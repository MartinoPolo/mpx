import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildModelLine, buildQuotaLine, resolveAccountLabel, resolveProjectLocation, buildLocationLabel } from '../src/claude-statusline/scripts/status-line.mts';
import { readCompactionHistory } from '../src/claude-statusline/scripts/lib/compaction.mts';

const renderer = resolve('src/claude-statusline/scripts/status-line.mts');
const subagentRenderer = resolve('src/claude-statusline/scripts/subagent-status-line.mts');
const plain = (value: string) => value.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');

function invoke(script: string, payload: Record<string, unknown>, environment: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 10_000,
    env: environment,
  });
  assert.equal(result.status, 0, result.stderr);
  return plain(result.stdout);
}

async function isolatedFixture(): Promise<{ root: string; config: string; cache: string; repository: string; transcript: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), 'mpx-statusline-fixture-'));
  const config = join(root, 'claude-personal');
  const cache = join(root, 'cache');
  const repository = join(root, 'fixture-repo');
  const transcript = join(root, 'session', 'session.jsonl');
  await mkdir(join(root, 'session'), { recursive: true });
  await mkdir(config); await mkdir(cache); await mkdir(repository);
  await writeFile(join(config, 'settings.json'), JSON.stringify({ effortLevel: 'high' }));
  await writeFile(transcript, '');
  return { root, config, cache, repository, transcript, env: { PATH: '', HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config, MPX_ACCOUNT: 'personal', TMPDIR: cache, TEMP: cache, TMP: cache, COLUMNS: '160' } };
}

const compaction = (trigger: string) => JSON.stringify({ subtype: 'compact_boundary', timestamp: '2026-01-01T00:00:00Z', compactMetadata: { trigger, preTokens: 180_000, postTokens: 20_000 } });

test('main entrypoint renders the three compact rows without real account or network effects', async () => {
  const fixture = await isolatedFixture();
  try {
    await writeFile(fixture.transcript, [compaction('auto'), compaction('manual')].join('\n') + '\n');
    const now = Math.floor(Date.now() / 1000);
    const output = invoke(renderer, {
      session_name: 'Carryover', session_id: '1234567890', cwd: fixture.repository, transcript_path: fixture.transcript,
      model: { display_name: 'Opus 5 (1M context)' }, effort: { level: 'high' },
      context_window: { context_window_size: 1_000_000, total_input_tokens: 123_000, used_percentage: 12 }, cost: { total_cost_usd: 1.25 },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: now + 7_300 }, seven_day: { used_percentage: 30, resets_at: now + 86_400 + 23 * 3_600 + 120 } },
    }, fixture.env);
    const rows = output.trimEnd().split('\n');
    assert.equal(rows.length, 3, output);
    assert.equal(rows[0], 'P · Carryover · #12345678 · fixture-repo');
    assert.match(rows[1]!, /^Opus 5 \(1M\) · ◆◆◆◇◇ · 123k [█░]{6} · \u{F0615} 2$/u);
    assert.match(rows[2]!, /^5h [█░]{4} 20% 2h 1m · 7d [█░]{4} 30% 1d 23h$/);
    assert.doesNotMatch(output, /\$|Kč|%\)|Σ|⟳/);
    assert.deepEqual((await readdir(fixture.cache)).filter(name => !name.startsWith('claude-usage-') && !name.startsWith('claude-compact-')), []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('compaction count is omitted until the session compacts', () => {
  const line = plain(buildModelLine({ model: 'Sonnet', effortLevel: '', sessionTokensIn: '84000', compactLimit: 167_000, compactionCount: 0 }));
  assert.equal(line, 'Sonnet · 84k ███░░░');
});

test('location label names the project and linked worktree, or just the folder', () => {
  const worktree = resolveProjectLocation('C:\\work\\worktrees\\mpx\\files-to-delete', { commonDir: 'C:/work/mpx/.git', toplevel: 'C:/work/worktrees/mpx/files-to-delete' });
  assert.equal(plain(buildLocationLabel(worktree)), 'mpx/files-to-delete');
  assert.match(buildLocationLabel(worktree), /\x1b\]8;;file:\/\/\/C:\/work\/worktrees\/mpx\/files-to-delete\x07/);
  const mainCheckout = resolveProjectLocation('C:\\work\\mpx', { commonDir: 'C:/work/mpx/.git', toplevel: 'C:/work/mpx' });
  assert.equal(plain(buildLocationLabel(mainCheckout)), 'mpx');
  assert.equal(plain(buildLocationLabel(resolveProjectLocation('/tmp/scratch', undefined))), 'scratch');
});

test('subagent panel collapses running agents into one summary row and hides the rest without writing state', async () => {
  const fixture = await isolatedFixture();
  try {
    const now = Date.now();
    const panel = invoke(subagentRenderer, { session_id: 'running-session', transcript_path: fixture.transcript, tasks: [
      { id: 'a', model: 'claude-sonnet-5-5', status: 'running', startTime: now - 65_000, tokenCount: 1000, description: 'First' },
      { id: 'b', model: 'claude-opus-5-5', status: 'running', startTime: now - 5_000, tokenCount: 2500, description: 'Second' },
      { id: 'c', model: 'claude-sonnet-5-5', status: 'completed', startTime: now - 9_000, tokenCount: 700, description: 'Done' },
    ] }, fixture.env);
    const rows = panel.trim().split('\n').map(line => JSON.parse(line) as { id: string; content: string });
    assert.deepEqual(rows.map(row => row.id), ['a', 'b', 'c']);
    assert.match(plain(rows[0]!.content), /^● 2 running · 1×Opus 1×Sonnet · 3\.5k tokens · 1m0\ds$/);
    assert.deepEqual(rows.slice(1).map(row => row.content), ['', '']);
    assert.deepEqual(await readdir(fixture.config), ['settings.json']);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('cold compaction scans advance in bounded chunks without claiming completion', async () => {
  const fixture = await isolatedFixture();
  try {
    const cache = join(fixture.cache, 'large-compaction.tsv');
    const largePrefix = 'x'.repeat(400_000) + '\n';
    await writeFile(fixture.transcript, largePrefix + compaction('auto') + '\n');
    assert.deepEqual(readCompactionHistory(fixture.transcript, cache), []);
    const firstOffset = Number((await readFile(cache, 'utf8')).split('\n')[0]);
    assert.ok(firstOffset > 0 && firstOffset < Buffer.byteLength(largePrefix + compaction('auto') + '\n'));
    let history = [] as ReturnType<typeof readCompactionHistory>;
    for (let tick = 0; tick < 4 && history.length === 0; tick += 1) history = readCompactionHistory(fixture.transcript, cache);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.trigger, 'auto');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('quota displays native values, stale cache age, and explicit unknown state', () => {
  assert.match(plain(buildQuotaLine({ fiveRaw: '20', fiveResets: '', sevenRaw: '30', sevenResets: '', usageSource: 'live', usageAgeSeconds: 0 })), /^5h [█░]{4} 20% · 7d [█░]{4} 30%$/);
  assert.match(plain(buildQuotaLine({ fiveRaw: '', fiveResets: '', sevenRaw: '', sevenResets: '', usageSource: '', usageAgeSeconds: 0 })), /unknown/i);
  const weeklyOnly = plain(buildQuotaLine({ fiveRaw: '', fiveResets: '', sevenRaw: '40', sevenResets: '', usageSource: 'live', usageAgeSeconds: 0 }));
  assert.match(weeklyOnly, /7d.*40%/);
  assert.doesNotMatch(weeklyOnly, /5h|unknown/i);
  assert.match(plain(buildQuotaLine({ fiveRaw: '20', fiveResets: '', sevenRaw: '30', sevenResets: '', usageSource: 'cache', usageAgeSeconds: 1_000 })), / · 16m$/);
  assert.match(plain(buildQuotaLine({ fiveRaw: '20', fiveResets: '', sevenRaw: '30', sevenResets: '', usageSource: 'cache', usageAgeSeconds: 3_600 })), /^⚠ .* · 1h old ⚠$/);
});

test('statusline sources make no network, credential, background-process, or launcher access', async () => {
  for (const script of [renderer, subagentRenderer]) {
    const source = await readFile(script, 'utf8');
    for (const forbidden of ['mpx-claude-code', 'credentials.json', 'statusline-projects.json', 'fetch(', 'spawn', 'vscode://', '[InternetShortcut]']) assert.equal(source.includes(forbidden), false, `${script}: ${forbidden}`);
  }
});

test('MPX_ACCOUNT controls badge account independently of config directory', () => {
  const previous = process.env.MPX_ACCOUNT;
  try {
    process.env.MPX_ACCOUNT = 'work'; assert.equal(resolveAccountLabel('/home/user/.claude'), 'Work');
    process.env.MPX_ACCOUNT = 'personal'; assert.equal(resolveAccountLabel('/home/user/.claude-work'), 'Personal');
  } finally { if (previous === undefined) delete process.env.MPX_ACCOUNT; else process.env.MPX_ACCOUNT = previous; }
});
