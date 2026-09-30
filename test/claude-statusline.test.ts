import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildQuotaLine, buildSubagentLine, resolveAccountLabel } from '../src/claude-statusline/scripts/status-line.mts';
import { readCompactionHistory } from '../src/claude-statusline/scripts/lib/compaction.mts';
import { effortDriftReasons } from '../src/claude-statusline/scripts/subagent-status-line.mts';

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
  await mkdir(join(root, 'session', 'session', 'subagents'), { recursive: true });
  await mkdir(config); await mkdir(cache); await mkdir(repository);
  await writeFile(join(config, 'settings.json'), JSON.stringify({ effortLevel: 'high' }));
  await writeFile(join(cache, 'claude-czk-cache.txt'), '23\n');
  await writeFile(transcript, '');
  return { root, config, cache, repository, transcript, env: { PATH: '', HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config, MPX_ACCOUNT: 'personal', TMPDIR: cache, TEMP: cache, TMP: cache, COLUMNS: '160' } };
}

test('isolated main entrypoint keeps latest layout without real account or network effects', async () => {
  const fixture = await isolatedFixture();
  try {
    const output = invoke(renderer, {
      session_name: 'Carryover', session_id: '1234567890', cwd: fixture.repository, transcript_path: fixture.transcript,
      model: { display_name: 'Opus 5 (1M context)' }, effort: { level: 'high' },
      context_window: { context_window_size: 1_000_000, total_input_tokens: 123_000, used_percentage: 12 }, cost: { total_cost_usd: 1.25 },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { used_percentage: 30, resets_at: Math.floor(Date.now() / 1000) + 86_400 } },
    }, fixture.env);
    for (const expected of ['P', 'Carryover', '#12345678', 'Opus 5 (1M)', '◆◆◆◇◇', 'fixture-repo', '123k', '$1.25', '28.75Kč', '5h', '7d']) assert.ok(output.includes(expected), `${expected}\n${output}`);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('subagent entrypoint writes live panel state and main entrypoint renders terminal ledger without cross-account reads', async () => {
  const fixture = await isolatedFixture();
  try {
    const sessionId = 'ledger-session';
    const workConfig = join(fixture.root, 'claude-work');
    await mkdir(join(workConfig, 'subagent-statusline-state'), { recursive: true });
    await writeFile(join(workConfig, 'subagent-statusline-state', `${sessionId}.tsv`), 'foreign\thaiku\tlow\t999\t1\tcompleted\n');
    await writeFile(join(fixture.root, 'session', 'session', 'subagents', 'agent-a.meta.json'), JSON.stringify({ agentType: 'mpx-executor', description: 'Finished fixture' }));
    const panel = invoke(subagentRenderer, { columns: 120, session_id: sessionId, transcript_path: fixture.transcript, tasks: [{ id: 'a', model: 'sonnet', effort: 'high', status: 'completed', startTime: Date.now() - 2000, tokenCount: 1200, contextWindowSize: 200000, description: 'Fixture task' }] }, fixture.env);
    assert.match(panel, /"id":"a"/); assert.match(panel, /Fixture task/); assert.match(panel, /sonnet/i);
    const main = invoke(renderer, { session_name: 'Ledger', session_id: sessionId, cwd: fixture.repository, transcript_path: fixture.transcript, model: { display_name: 'Sonnet' }, context_window: {} }, fixture.env);
    assert.match(main, /Finished fixture|mpx-executor/i);
    assert.doesNotMatch(main, /foreign|999/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('finished-agent ledger omits type counts when reviewer history overflows', () => {
  const reviewerTypes = ['code-quality', 'best-practices', 'spec-alignment', 'test-quality', 'security', 'performance', 'error-handling'].map(name => `mpx-reviewer-${name}`);
  const rows = reviewerTypes.slice(0, 5).map((type, index) => ({
    id: `reviewer-${index}`, type, tier: 'sonnet', effort: 'high', tokens: 1200,
    elapsedMs: 2000, status: 'completed', drifted: false,
  }));
  const lines = buildSubagentLine({
    summary: {
      agents: reviewerTypes.length,
      tiers: [{ label: 'sonnet', count: reviewerTypes.length, tokens: 8400, drifted: false }],
      types: reviewerTypes.map(label => ({ label, count: 1, tokens: 1200, drifted: false })),
      rows, hiddenRows: reviewerTypes.length - rows.length,
    },
    sessionTranscript: '', agentDefinition: () => '', compactions: () => ({ auto: 0, manual: 0 }),
  }).map(plain);
  assert.equal(lines.length, 1 + rows.length + 1);
  assert.match(lines[0]!, /Σ 7 agents.*7×Sonnet.*8\.4k/);
  assert.doesNotMatch(lines.join('\n'), /\d+×mpx-reviewer-/);
  for (const row of rows) assert.ok(lines.some(line => line.includes(`✓ ${row.type}`)));
  assert.match(lines.at(-1)!, /\+2 more/);
});

test('subagent entrypoint rejects traversal identifiers without outside writes', async () => {
  const fixture = await isolatedFixture();
  try {
    const escaped = join(fixture.root, 'escaped.tsv');
    const output = invoke(subagentRenderer, { session_id: '../escaped', transcript_path: fixture.transcript, tasks: [{ id: '../agent', status: 'completed' }] }, fixture.env);
    assert.equal(output, '');
    await assert.rejects(access(escaped));
    await assert.rejects(access(join(fixture.config, 'subagent-statusline-state')));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('cold compaction scans advance in bounded chunks without claiming completion', async () => {
  const fixture = await isolatedFixture();
  try {
    const cache = join(fixture.cache, 'large-compaction.tsv');
    const event = JSON.stringify({ subtype: 'compact_boundary', timestamp: '2026-01-01T00:00:00Z', compactMetadata: { trigger: 'auto', preTokens: 10, postTokens: 2 } });
    const largePrefix = 'x'.repeat(400_000) + '\n';
    await writeFile(fixture.transcript, largePrefix + event + '\n');
    assert.deepEqual(readCompactionHistory(fixture.transcript, cache), []);
    const firstOffset = Number((await readFile(cache, 'utf8')).split('\n')[0]);
    assert.ok(firstOffset > 0 && firstOffset < Buffer.byteLength(largePrefix + event + '\n'));
    let history = [] as ReturnType<typeof readCompactionHistory>;
    for (let tick = 0; tick < 4 && history.length === 0; tick += 1) history = readCompactionHistory(fixture.transcript, cache);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.trigger, 'auto');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('native effort presentation does not reintroduce the retired high ceiling', () => {
  assert.deepEqual(effortDriftReasons('sonnet', 'xhigh', false, true), []);
  assert.deepEqual(effortDriftReasons('haiku', 'low', false, true), []);
  assert.deepEqual(effortDriftReasons('opus', 'max', false, true), []);
});

test('quota displays native values and explicit unknown state', () => {
  assert.match(plain(buildQuotaLine({ fiveRaw: '20', fiveResets: '', sevenRaw: '30', sevenResets: '', usageSource: 'live', usageAgeSeconds: 0 })), /5h.*20%.*7d.*30%/);
  assert.match(plain(buildQuotaLine({ fiveRaw: '', fiveResets: '', sevenRaw: '', sevenResets: '', usageSource: '', usageAgeSeconds: 0 })), /unknown/i);
});

test('statusline source has no legacy dependency, auth-file read, port registry, or launcher generation', async () => {
  const source = await readFile(renderer, 'utf8');
  for (const forbidden of ['mpx-claude-code', '.credentials.json', 'credentials.json', 'statusline-projects.json', '--warm-usage', '--warm-ports', 'vscode://', '[InternetShortcut]']) assert.equal(source.includes(forbidden), false, forbidden);
});

test('MPX_ACCOUNT controls badge account independently of config directory', () => {
  const previous = process.env.MPX_ACCOUNT;
  try {
    process.env.MPX_ACCOUNT = 'work'; assert.equal(resolveAccountLabel('/home/user/.claude'), 'Work');
    process.env.MPX_ACCOUNT = 'personal'; assert.equal(resolveAccountLabel('/home/user/.claude-work'), 'Personal');
  } finally { if (previous === undefined) delete process.env.MPX_ACCOUNT; else process.env.MPX_ACCOUNT = previous; }
});
