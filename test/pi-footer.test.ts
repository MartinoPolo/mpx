import assert from 'node:assert/strict';
import test from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import {
  colorAgentModel,
  renderPiFooter,
  renderPiFooterLayout,
  thinkingGauge,
  type FooterSnapshot,
} from '../src/pi-footer.js';

const theme: Pick<Theme, 'fg' | 'bold'> = {
  fg: (color, text) => `\x1b[${color === 'dim' ? 90 : color === 'error' ? 31 : color === 'warning' ? 33 : color === 'success' ? 32 : 37}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

function snapshot(overrides: Partial<FooterSnapshot> = {}): FooterSnapshot {
  return {
    sessionId: '12345678-abcdef',
    model: 'anthropic/claude-sonnet-4',
    effort: 'high',
    location: { project: 'mpx', worktree: 'feature-tree', branch: 'footer' },
    contextPercent: 42,
    contextTokens: 42_123,
    compactionTrigger: 100_000,
    cost: 1.25,
    compactions: [],
    quota: [{ label: '5h', usedPercent: 23, resetAt: 1_700_003_600_000 }],
    quotaObservedAt: 1_700_000_000_000,
    agents: [],
    now: 1_700_000_000_000,
    ...overrides,
  };
}

function plain(lines: string[]): string[] {
  return lines.map(stripTerminalSequences);
}

function assertBounded(lines: string[], width: number): void {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${stripTerminalSequences(line)}`);
}

test('renders the five core lines in order with exact account color and no runtime extras', () => {
  const lines = renderPiFooter(snapshot({ account: 'personal' }), 100, theme);
  const text = plain(lines);
  assert.equal(lines.length, 5);
  assert.match(text[0]!, /^▾ New session · #12345678 · Personal$/);
  assert.ok(lines[0]!.includes('\x1b[38;2;71;127;204mPersonal\x1b[0m'));
  assert.match(text[1]!, /^claude-sonnet-4 · ◆◆◆◆◇◇$/);
  assert.equal(text[2], 'mpx · feature-tree · footer');
  assert.match(text[3]!, /42\.1k \(42%\)/);
  assert.doesNotMatch(text[3]!, /Context/);
  assert.match(text[3]!, /\$1\.250$/);
  assert.match(text[4]!, /^5h ██░░░░░░ 23% 1h$/);
  assert.doesNotMatch(text.join('\n'), /port|dirty|ahead|runtime/i);
});

test('agent model tiers use stable colors', () => {
  assert.match(colorAgentModel('gpt-6-astra', 'Astra', theme), /^\x1b\[38;5;48m/);
  assert.match(colorAgentModel('gpt-6-sol', 'Sol', theme), /^\x1b\[38;5;39m/);
  assert.match(colorAgentModel('gpt-6-luna', 'Luna', theme), /^\x1b\[38;5;226m/);
  assert.match(colorAgentModel('gpt-6-terra', 'Terra', theme), /^\x1b\[38;5;208m/);
  assert.match(colorAgentModel('vendor/custom', 'custom', theme), /^\x1b\[37m/);
});

test('main model uses the same tier color in expanded and compact views', () => {
  const value = snapshot({ model: 'gpt-6-sol' });
  assert.match(renderPiFooter(value, 120, theme, 'summary')[1]!, /^\x1b\[38;5;39mSol/);
  assert.match(renderPiFooter(value, 120, theme, 'compact')[0]!, /\x1b\[38;5;39mSol/);
});

test('thinkingGauge implements every original six-slot effort level', () => {
  assert.deepEqual(
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown'].map(level => stripTerminalSequences(thinkingGauge(level))),
    ['◇◇◇◇◇◇', '◆◇◇◇◇◇', '◆◆◇◇◇◇', '◆◆◆◇◇◇', '◆◆◆◆◇◇', '◆◆◆◆◆◇', '◆◆◆◆◆◆', '<unknown>'],
  );
});

test('unknown and nonfinite metrics are unavailable rather than fabricated zeroes', () => {
  const text = plain(renderPiFooter(snapshot({ account: undefined, contextTokens: Number.NaN, contextPercent: Number.NaN, cost: Infinity, quota: undefined }), 90, theme));
  assert.equal(text[0], '▾ New session · #12345678');
  assert.equal(text[3], 'usage unavailable');
  assert.doesNotMatch(text[3]!, /Context/);
  assert.equal(text[4], 'unavailable');
  assert.doesNotMatch(text.join('\n'), /Personal| · Work$|0%|\$0/);
});

test('sanitizes terminal text and unsafe links while preserving safe full OSC8 targets', () => {
  const lines = renderPiFooter(snapshot({
    sessionName: 'bad\x1b]8;;https://evil.test\x1b\\name\nX',
    sessionUrl: 'javascript:alert(1)',
    location: {
      project: '項目\x1b[31m', worktree: 'tree', branch: 'main',
      projectUrl: 'https://example.test/a/very/long/path?x=1',
      worktreeUrl: 'file:///C:/safe/tree',
      branchUrl: 'https://user:secret@example.test/nope',
    },
  }), 48, theme);
  const joined = lines.join('\n');
  assert.doesNotMatch(stripTerminalSequences(joined), /evil|\nX|javascript|secret/);
  assert.ok(joined.includes('\x1b]8;;https://example.test/a/very/long/path?x=1\x1b\\'));
  assert.ok(joined.includes('\x1b]8;;file:///C:/safe/tree\x1b\\'));
  assert.ok(!joined.includes('https://user:secret'));
  assertBounded(lines, 48);
});

test('reserves session id and account while truncating a long session name', () => {
  const text = plain(renderPiFooter(snapshot({ sessionName: 'A very long session name that cannot possibly fit', account: 'work' }), 34, theme));
  assert.match(text[0]!, /… · #12345678 · Work$/);
});

test('caps worktree and branch labels at twenty display cells while preserving complete links', () => {
  const location = {
    project: 'project',
    worktree: '超長工作樹名稱超長工作樹名稱',
    branch: 'feature/a-very-long-footer-branch',
    projectUrl: 'file:///C:/projects/project',
    worktreeUrl: 'file:///C:/projects/a-complete-worktree-destination',
    branchUrl: 'https://example.test/project/tree/feature%2Fa-very-long-footer-branch',
    editorUrl: 'vscode://file/C:/projects/a-complete-worktree-destination',
  };
  const line = renderPiFooter(snapshot({ location }), 120, theme)[2]!;
  const fields = stripTerminalSequences(line).split(' · ');
  assert.equal(fields.length, 3);
  assert.equal(fields[0], 'project 󰨞');
  assert.ok(visibleWidth(fields[1]!) <= 20 && fields[1]!.endsWith('…'));
  assert.ok(visibleWidth(fields[2]!) <= 20 && fields[2]!.endsWith('…'));
  assert.doesNotMatch(stripTerminalSequences(line), /VS Code/);
  assert.ok(line.includes(`\x1b]8;;${location.editorUrl}\x1b\\`));
  assert.ok(line.indexOf(location.projectUrl) < line.indexOf(location.editorUrl));
  assert.ok(line.indexOf(location.editorUrl) < line.indexOf(location.worktreeUrl));
  for (const width of [1, 20, 35, 60]) {
    assertBounded(renderPiFooter(snapshot({ location }), width, theme), width);
  }
  assert.ok(line.includes(location.worktreeUrl));
  assert.ok(line.includes(location.branchUrl));
  assert.ok(line.includes(location.editorUrl));
});

test('keeps review beside effort on the existing model row with full links and no added row', () => {
  const url = 'https://github.com/owner/project/pull/4242?complete=true';
  const lines = renderPiFooter(snapshot({
    location: { project: 'project-with-a-long-name', worktree: 'worktree-with-a-long-name', branch: 'branch-with-a-long-name' },
    review: { provider: 'github', number: 4242, url, title: '修正 footer metadata that is long' },
  }), 60, theme);
  const text = plain(lines);
  assert.equal(lines.length, renderPiFooter(snapshot(), 60, theme).length);
  assert.equal(text[2]!.includes('PR #4242'), false);
  assert.match(text[1]!, /◆.* · PR #4242 · 修/);
  assert.ok(lines[1]!.includes(url));
  assertBounded(lines, 60);

  const narrow = renderPiFooter(snapshot({
    model: 'a-model-name-that-would-otherwise-hide-the-review',
    review: { provider: 'gitlab', number: 42, url: 'https://gitlab.example/group/project/-/merge_requests/42' },
  }), 35, theme);
  assert.match(plain(narrow)[1]!, /… · ◆.* · MR !42$/);
  assertBounded(narrow, 35);
});

test('balances location widths and bounds Unicode output at narrow and zero widths', () => {
  const narrow = renderPiFooter(snapshot({ location: { project: '超長項目名稱', worktree: 'another-very-long-worktree', branch: 'feature/extremely-long' } }), 35, theme);
  const location = plain(narrow)[2]!;
  assert.match(location, /^超.* · another.* · feature/);
  assert.doesNotMatch(location, /Project |Worktree |Branch |P:|W:|B:/);
  assertBounded(narrow, 35);
  assert.deepEqual(renderPiFooter(snapshot(), 0, theme), []);
  assertBounded(renderPiFooter(snapshot(), 1, theme), 1);
});

test('shows bounded recent compaction history as a local-time tree with earlier count', () => {
  const compactions = Array.from({ length: 7 }, (_, index) => ({ id: `c${index}`, timestamp: `2025-01-01T10:0${index}:00`, reason: `reason ${index}` }));
  const text = plain(renderPiFooter(snapshot({ compactions }), 90, theme));
  const context = text.findIndex(line => line.includes('42.1k (42%)'));
  assert.equal(text[context + 1], '  ├─ … 2 earlier compactions');
  assert.match(text[context + 2]!, /^  ├─ reason 2 · 10:02$/);
  assert.match(text[context + 6]!, /^  └─ reason 6 · 10:06$/);
  assert.match(text.at(-1)!, /^5h /);
});

test('compactions show their native pre-compaction context count, including after resume without a reason', () => {
  const text = plain(renderPiFooter(snapshot({ compactions: [
    { id: 'manual', timestamp: '2026-09-14T21:36:00', reason: 'manual', tokensBefore: 47_853 },
    { id: 'resumed', timestamp: '2026-09-14T21:37:00', tokensBefore: 12_345 },
  ] }), 100, theme));
  assert.equal(text[4], '  ├─ manual · 47.9k · 21:36');
  assert.equal(text[5], '  └─ compacted · 12.3k · 21:37');
});

test('marks old quota observations stale and reached reset times awaiting update', () => {
  const stale = plain(renderPiFooter(snapshot({ now: 1_700_001_000_000 }), 90, theme)).at(-1)!;
  assert.match(stale, /stale/);
  const expired = plain(renderPiFooter(snapshot({ now: 1_700_004_000_000 }), 90, theme)).at(-1)!;
  assert.equal(expired, '5h awaiting update');
});

test('details expands agents beneath their model row with status, model, effort, elapsed time, and links', () => {
  const agents = Array.from({ length: 7 }, (_, index) => ({
    id: `agent-${index}`, type: `reviewer-${index}`, status: index === 6 ? 'completed' : 'failed',
    model: 'openai/gpt-5', effort: 'medium', elapsedMs: 65_000 + index * 1000,
    peakInputTokens: index === 0 ? undefined : index * 100,
    url: index === 6 ? 'https://example.test/agent' : undefined,
  }));
  const wideLines = renderPiFooter(snapshot({ agents }), 180, theme, 'details');
  const wide = plain(wideLines);
  const groupRow = wide.findIndex(line => /▾ gpt-5/.test(line));
  assert.ok(groupRow > 0);
  assert.match(wide[groupRow + 1]!, /✓ reviewer-6 · gpt-5 · ◆◆◆◇◇◇ · 1m 11s  · 600/);
  assert.ok(wideLines.some(line => line.includes('https://example.test/agent')));
  assert.doesNotMatch(wide.join('\n'), /Finished agents/);
  assertBounded(wideLines, 180);
  assertBounded(renderPiFooter(snapshot({ agents }), 60, theme, 'details'), 60);
});

test('agent token columns stay fixed across normal, unknown, and extreme elapsed times', () => {
  const elapsedValues = [5000, 65_000, 3_660_000, 183_600_000, undefined, Number.MAX_VALUE];
  const agents = elapsedValues.map((elapsedMs, index) => ({
    id: `agent-${index}`, type: `Worker-${index}`, status: 'done', model: 'gpt-6-luna', effort: 'high',
    elapsedMs, peakInputTokens: 123_800,
  }));
  const detailRows = plain(renderPiFooter(snapshot({ agents }), 200, theme, 'details'))
    .filter(line => /^    ✓ Worker-/.test(line));
  const tokenColumns = detailRows.map(line => line.indexOf('123.8k'));
  assert.equal(new Set(tokenColumns).size, 1);
  const elapsedFields = detailRows.map(line => line.split(' · ')[3]!);
  assert.deepEqual(elapsedFields.slice(0, 5), ['5s     ', '1m 5s  ', '1h 1m  ', '2d 3h  ', 'unknown']);
  assert.equal(visibleWidth(elapsedFields[5]!), 7);
  assert.match(elapsedFields[5]!, /…$/);

  const columnsAcrossRenders = elapsedValues.map((elapsedMs, index) => {
    const [row] = plain(renderPiFooter(snapshot({ agents: [{
      id: `single-${index}`, type: 'Worker-0', status: 'done', model: 'gpt-6-luna', effort: 'high',
      elapsedMs, peakInputTokens: 123_800,
    }] }), 200, theme, 'details')).filter(line => /^    ✓ Worker-/.test(line));
    return row!.indexOf('123.8k');
  });
  assert.equal(new Set(columnsAcrossRenders).size, 1);
});

test('shortens only provider prefixes and formats valid cost safely', () => {
  const text = plain(renderPiFooter(snapshot({ model: 'vendor/custom-model-v9', cost: 0.004 }), 90, theme));
  assert.match(text[1]!, /^custom-model-v9 /);
  assert.match(text[3]!, /\$0\.004/);
});

test('wide columns retain title, account, and all location values', () => {
  const text = plain(renderPiFooter(snapshot({
    sessionName: 'Footer title', account: 'work',
    location: { project: 'project-name', worktree: 'worktree-name', branch: 'branch-name' },
    agents: [{ id: 'a', type: 'reviewer', status: 'done', model: 'openai/gpt-5', effort: 'max', elapsedMs: 1000 }],
  }), 180, theme));
  assert.match(text[0]!, /^▾ Footer title · #12345678 · Work$/);
  assert.match(text[2]!, /^project-name · worktree-name · branch-name/);
});

test('project is white and a main checkout leaves only project and branch links', () => {
  const location = { project: 'prejemesi', branch: 'dev', projectUrl: 'file:///C:/projects/prejemesi', branchUrl: 'https://example.test/tree/dev' };
  const line = renderPiFooter(snapshot({ location }), 100, theme)[2]!;
  assert.equal(stripTerminalSequences(line), 'prejemesi · dev');
  assert.ok(line.includes('\x1b[38;2;255;255;255mprejemesi\x1b[0m'));
  assert.ok(line.includes(location.projectUrl));
  assert.ok(line.includes(location.branchUrl));
});

test('effort diamonds retain the legacy level palette without words', () => {
  for (const [level, color] of Object.entries({ off: 255, minimal: 245, low: 114, medium: 75, high: 179, xhigh: 208, max: 203 })) {
    const gauge = thinkingGauge(level);
    assert.ok(gauge.startsWith(`\x1b[38;5;${color}m`), level);
    assert.match(stripTerminalSequences(gauge), /^[◆◇]{6}$/);
    assert.ok(gauge.endsWith('\x1b[0m'));
  }
});

test('context text and filled cells escalate against compaction trigger, not window percentage', () => {
  for (const [tokens, prefix] of [
    [49_999, '\x1b[37m'], [50_000, '\x1b[33m'], [69_999, '\x1b[33m'],
    [70_000, '\x1b[38;5;208m'], [89_999, '\x1b[38;5;208m'], [90_000, '\x1b[31m'],
  ] as const) {
    const line = renderPiFooter(snapshot({ contextTokens: tokens, contextPercent: 40.9 }), 100, theme)[3]!;
    assert.ok(line.startsWith(prefix), String(tokens));
    assert.ok(line.includes(`${prefix}█████`));
    assert.match(stripTerminalSequences(line), /\(40%\)/);
  }
  const disabled = renderPiFooter(snapshot({ contextTokens: 999, contextPercent: null, compactionTrigger: 0 }), 100, theme)[3]!;
  assert.equal(stripTerminalSequences(disabled), '999 · $1.250');
  for (const contextTokens of [undefined, null, NaN, Infinity, -1]) {
    const line = stripTerminalSequences(renderPiFooter(snapshot({ contextTokens }), 100, theme)[3]!);
    assert.equal(line, 'usage unavailable · $1.250');
  }
});

test('quota bars keep accent used cells and muted empty cells at every utilization', () => {
  const quotaTheme: Pick<Theme, 'fg' | 'bold'> = { fg: (color, text) => `<${color}>${text}</${color}>`, bold: text => text };
  for (const [usedPercent, cells] of [[0, 0], [12, 1], [50, 4], [90, 7], [100, 8]] as const) {
    const line = renderPiFooter(snapshot({ quota: [{ label: '5h', usedPercent }] }), 400, quotaTheme).at(-1)!;
    assert.ok(line.includes(`<accent>${'█'.repeat(cells)}</accent><borderMuted>${'░'.repeat(8 - cells)}</borderMuted>`));
    assert.doesNotMatch(line, /<warning>|<error>/);
  }
});

test('unknown effort and quota reset are explicit', () => {
  const text = plain(renderPiFooter(snapshot({ effort: 'surprise', quota: [{ label: 'day', usedPercent: 10 }] }), 90, theme));
  assert.match(text[1]!, /<unknown>/);
  assert.doesNotMatch(text[1]!, /[◆◇]/);
  assert.match(text.at(-1)!, /reset unavailable/);
});

test('quota has no added labels and every footer separator is subdued gray', () => {
  const lines = renderPiFooter(snapshot({
    account: 'personal', compactions: [{ id: 'c', reason: 'manual', timestamp: '2026-09-14T21:36:00', tokensBefore: 47_853 }],
    quota: [{ label: '5h', usedPercent: 23, resetAt: 1_700_003_600_000 }, { label: '7d', usedPercent: 42, resetAt: 1_700_003_600_000 }],
    agents: [{ id: 'a', type: 'reviewer', status: 'done', model: 'gpt-5', effort: 'medium', elapsedMs: 1000 }],
  }), 180, theme);
  assert.doesNotMatch(plain(lines).join('\n'), /Quota|resets in/);
  for (const line of lines) {
    const dots = stripTerminalSequences(line).split(' · ').length - 1;
    assert.equal(line.split('\x1b[90m · \x1b[0m').length - 1, dots);
  }
});

test('linked agent details retain the elapsed field and stay bounded', () => {
  const value = snapshot({
    agents: [{
      id: 'a', type: 'reviewer', status: 'done', model: 'openai/gpt-5', effort: 'high', elapsedMs: 1000,
      peakInputTokens: 123_800, url: 'https://example.test/agent',
    }],
  });
  const lines = renderPiFooter(value, 180, theme, 'details');
  const linkedRow = lines.find(line => line.includes('https://example.test/agent'))!;
  assert.match(stripTerminalSequences(linkedRow), /1s      · 123\.8k$/);
  assert.match(linkedRow, /\x1b]8;;\x1b\\$/);
  for (const width of [1, 40, 60, 180]) assertBounded(renderPiFooter(value, width, theme, 'details'), width);
});

test('compact is one bounded bar-free line with aliases, context, and every quota reset', () => {
  const lines = renderPiFooter(snapshot({
    model: 'gpt-6-luna',
    quota: [
      { label: '5h', usedPercent: 23, resetAt: 1_700_003_600_000 },
      { label: '7d', usedPercent: 42, resetAt: 1_700_007_200_000 },
    ],
  }), 120, theme, 'compact');
  assert.equal(lines.length, 1);
  assert.match(plain(lines)[0]!, /^▸ · #12345678 · Luna · ◆◆◆◆◇◇ · 42\.1k \(42%\) · 5h 23% 1h · 7d 42% 2h$/);
  assert.doesNotMatch(plain(lines)[0]!, /[█░]/);
  assertBounded(lines, 120);
});

test('default history shows every closed model-effort group with honest aggregate metrics', () => {
  const agents = [
    { id: 'run', type: 'runner', status: 'running', model: 'gpt-9-running', effort: 'high', peakInputTokens: 99_000, cost: 99 },
    { id: 'priced', type: 'worker', status: 'done', model: 'gpt-6-astra', effort: 'high', peakInputTokens: 100, cost: 0 },
    { id: 'partial-a', type: 'worker', status: 'done', model: 'unknown', effort: 'low', peakInputTokens: 9000 },
    { id: 'partial-b', type: 'worker', status: 'failed', model: 'unknown', effort: 'low', cost: 5 },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `extra-${index}`, type: 'worker', status: 'done', model: `model-${index}`, effort: 'medium', peakInputTokens: index + 1 })),
  ];
  const text = plain(renderPiFooter(snapshot({ agents }), 140, theme, 'summary'));
  const history = text.findIndex(line => line === '▾ History (9)');
  assert.ok(history >= 0);
  assert.equal(text.filter(line => /^  ▸ /.test(line)).length, 8, 'all groups remain reachable');
  assert.match(text[history + 1]!, /Astra.*\$0\.000/);
  assert.ok(text.some(line => /unknown.*9\.0k known.*\$5\.000 known cost/.test(line)));
  assert.doesNotMatch(text.join('\n'), /running|more groups/);
});

test('history summary columns align by terminal width across mixed models and metrics', () => {
  const agents = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `sol-${index}`, type: 'Worker', status: 'done', model: 'gpt-6-sol',
      effort: 'high', peakInputTokens: 20_000, cost: 0.1,
    })),
    { id: 'terra', type: 'Worker', status: 'done', model: 'gpt-6-terra', effort: 'medium', peakInputTokens: 900, cost: 0.01 },
    { id: 'wide', type: 'Worker', status: 'done', model: '模型', effort: 'unknown' },
    { id: 'old', type: 'Worker', status: 'done', model: 'gpt-5.10-luna', effort: 'low', cost: 0 },
    { id: 'new', type: 'Worker', status: 'done', model: 'gpt-6-luna', effort: 'low', peakInputTokens: 1000 },
  ];
  for (const view of ['summary', 'details'] as const) {
    const rows = plain(renderPiFooter(snapshot({ agents }), 180, theme, view))
      .filter(line => /^  [▸▾] /.test(line));
    assert.equal(rows.length, 5);
    const separatorColumns = rows.map(row => [...row.matchAll(/ · /g)]
      .map(match => visibleWidth(row.slice(0, match.index))));
    assert.equal(separatorColumns[0]!.length, 4);
    for (const columns of separatorColumns) assert.deepEqual(columns, separatorColumns[0]);
    assert.ok(rows.some(row => /Sol +·/.test(row)));
    assert.ok(rows.some(row => /gpt-5\.10-luna/.test(row)));
    assert.ok(rows.some(row => /×12 · 240\.0k \(20\.0k\) · \$1\.200$/.test(row)));
    assert.ok(rows.some(row => /×1 +· 900 +· \$0\.010$/.test(row)));
    assert.ok(rows.every(row => row === row.trimEnd()));
    for (const width of [3, 20, 45]) assertBounded(renderPiFooter(snapshot({ agents }), width, theme, view), width);
  }
});

test('history never merges distinct model versions sharing a short display alias', () => {
  const agents = [
    { id: 'one', type: 'Explore', status: 'completed', model: 'gpt-5.10-luna', effort: 'high', peakInputTokens: 100 },
    { id: 'two', type: 'Explore', status: 'completed', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 200 },
    { id: 'three', type: 'Explore', status: 'steered', model: 'gpt-5-mini', effort: 'high', peakInputTokens: 300 },
  ];
  const text = plain(renderPiFooter(snapshot({ agents }), 120, theme, 'summary')).join('\n');
  assert.match(text, /History \(3\)/);
  assert.match(text, /gpt-5\.10-luna.*×1.*100/);
  assert.match(text, /gpt-6-luna.*×1.*200/);
  assert.match(text, /gpt-5-mini.*×1.*300/);
  assert.doesNotMatch(text, /×2/);
});

test('expanded groups rank up to ten agents by peak input with unknown peaks last and deterministic ties', () => {
  const agents = [
    ...Array.from({ length: 11 }, (_, index) => ({ id: `known-${String(index).padStart(2, '0')}`, type: `agent-${index}`, status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: index, cost: 100 - index })),
    { id: 'unknown-a', type: 'unknown-a', status: 'done', model: 'gpt-6-luna', effort: 'high', cost: 999 },
    { id: 'unknown-b', type: 'unknown-b', status: 'done', model: 'gpt-6-luna', effort: 'high' },
  ];
  const text = plain(renderPiFooter(snapshot({ agents }), 160, theme, 'details'));
  const agentRows = text.filter(line => /^    [✓■×] /.test(line));
  assert.equal(agentRows.length, 10);
  assert.deepEqual(
    agentRows.map(row => row.match(/agent-\d+/)?.[0]),
    Array.from({ length: 10 }, (_, index) => `agent-${10 - index}`),
  );
  assert.ok(text.some(line => /… 3 more agents/.test(line)));
  assert.doesNotMatch(agentRows.join('\n'), /unknown-a|unknown-b|agent-0/);

  const tied = plain(renderPiFooter(snapshot({ agents: [
    { id: 'z-last', type: 'zeta', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 10 },
    { id: 'a-first', type: 'alpha', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 10 },
  ] }), 160, theme, 'details')).filter(line => /^    [✓■×] /.test(line));
  assert.match(tied[0]!, /alpha/);
  assert.match(tied[1]!, /zeta/);
});

test('multi-agent summaries show summed and largest peaks with honest partial knowledge', () => {
  const text = plain(renderPiFooter(snapshot({ agents: [
    { id: 'high', type: 'High', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 155_300 },
    { id: 'lower', type: 'Lower', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 100_000 },
    { id: 'unknown', type: 'Unknown', status: 'done', model: 'gpt-6-luna', effort: 'high' },
  ] }), 160, theme, 'details'));
  assert.match(text.find(line => /^  ▾ Luna/.test(line))!, /×3 · 255\.3k known \(155\.3k known\)/);
  assert.doesNotMatch(text.join('\n'), /tokens/i);
  const details = text.filter(line => /^    [✓■×] /.test(line));
  assert.match(details[0]!, /High.*155\.3k/);
  assert.match(details[1]!, /Lower.*100\.0k/);
  assert.match(details[2]!, /Unknown.*—/);
});

test('aggregate peaks format normal multi-agent and singleton groups without ambiguity', () => {
  const multi = plain(renderPiFooter(snapshot({ agents: [
    { id: 'a', type: 'Worker', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 123_800 },
    { id: 'b', type: 'Worker', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 100_000 },
    { id: 'c', type: 'Worker', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 100_000 },
    { id: 'd', type: 'Worker', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 94_200 },
  ] }), 160, theme));
  assert.match(multi.find(line => /^  ▸ Luna/.test(line))!, /×4 · 418\.0k \(123\.8k\)/);

  const singleton = plain(renderPiFooter(snapshot({ agents: [
    { id: 'only', type: 'Worker', status: 'done', model: 'gpt-6-terra', effort: 'high', peakInputTokens: 123_800 },
  ] }), 160, theme));
  const singletonSummary = singleton.find(line => /^  ▸ Terra/.test(line))!;
  assert.match(singletonSummary, /×1 · 123\.8k ·/);
  assert.doesNotMatch(singletonSummary, /\(/);
});

test('aggregate peaks distinguish unknown, zero, and invalid values', () => {
  const text = plain(renderPiFooter(snapshot({ agents: [
    { id: 'unknown-a', type: 'Worker', status: 'done', model: 'unknown-model', effort: 'high' },
    { id: 'unknown-b', type: 'Worker', status: 'done', model: 'unknown-model', effort: 'high', peakInputTokens: Number.NaN },
    { id: 'zero', type: 'Worker', status: 'done', model: 'zero-model', effort: 'high', peakInputTokens: 0 },
    { id: 'negative', type: 'Worker', status: 'done', model: 'zero-model', effort: 'high', peakInputTokens: -1 },
    { id: 'infinite', type: 'Worker', status: 'done', model: 'zero-model', effort: 'high', peakInputTokens: Infinity },
  ] }), 180, theme));
  assert.match(text.find(line => /^  ▸ unknown-model/.test(line))!, /×2 · — \(—\)/);
  assert.match(text.find(line => /^  ▸ zero-model/.test(line))!, /×3 · 0 known \(0 known\)/);
});

test('model summary aggregates every agent peak beyond the visible detail limit', () => {
  const agents = Array.from({ length: 12 }, (_, index) => ({
    id: `agent-${index}`, type: `Worker-${index}`, status: 'done',
    model: 'gpt-6-terra', effort: 'high', peakInputTokens: index === 11 ? 30_000 : 18_000,
  }));
  for (const view of ['summary', 'details'] as const) {
    const text = plain(renderPiFooter(snapshot({ agents }), 160, theme, view));
    assert.match(text.find(line => /^  [▸▾] Terra/.test(line))!, /×12 · 228\.0k \(30\.0k\) ·/);
    assert.equal(text.filter(line => /^    ✓ /.test(line)).length, view === 'details' ? 10 : 0);
  }
});

test('clipped disclosure glyphs do not register click controls', () => {
  const agents = [{ id: 'one', type: 'Explore', status: 'done', model: 'gpt-6-luna', effort: 'low', peakInputTokens: 10 }];
  const compact = renderPiFooterLayout(snapshot({ agents }), 1, theme, {
    view: 'compact', historyExpanded: true, expandedGroups: new Set(),
  });
  assert.equal(compact.controls.some(control => control.kind === 'footer'), false);
  const expanded = renderPiFooterLayout(snapshot({ agents }), 3, theme, {
    view: 'summary', historyExpanded: true, expandedGroups: new Set(),
  });
  assert.equal(expanded.controls.some(control => control.kind === 'group'), false);
});

test('collapsed history is one aggregate line combining efforts per exact model and disambiguating aliases', () => {
  const agents = [
    { id: 'one', type: 'Explore', status: 'done', model: 'gpt-5.10-luna', effort: 'low', cost: 1 },
    { id: 'two', type: 'Review', status: 'failed', model: 'gpt-5.10-luna', effort: 'high' },
    { id: 'three', type: 'Plan', status: 'done', model: 'gpt-6-luna', effort: 'high', cost: 2 },
  ];
  const layout = renderPiFooterLayout(snapshot({ agents }), 180, theme, {
    view: 'summary', historyExpanded: false, expandedGroups: new Set(),
  });
  const text = plain(layout.lines);
  assert.equal(text.filter(line => line.includes('History')).length, 1);
  assert.match(text.at(-1)!, /^▸ History \(3\) · \$3\.000 known cost · gpt-5\.10-luna ×2 · gpt-6-luna ×1$/);
});

test('one model group can expand independently while the other remains a summary', () => {
  const agents = [
    { id: 'one', type: 'Explore', status: 'done', model: 'gpt-6-luna', effort: 'low', peakInputTokens: 10 },
    { id: 'two', type: 'Review', status: 'done', model: 'gpt-6-terra', effort: 'high', peakInputTokens: 20 },
  ];
  const defaultLayout = renderPiFooterLayout(snapshot({ agents }), 160, theme, {
    view: 'summary', historyExpanded: true, expandedGroups: new Set(),
  });
  const groupControls = defaultLayout.controls.filter(control => control.kind === 'group');
  assert.equal(groupControls.length, 2);
  const luna = groupControls.find(control => control.groupKey?.includes('gpt-6-luna'))!;
  const expanded = plain(renderPiFooterLayout(snapshot({ agents }), 160, theme, {
    view: 'summary', historyExpanded: true, expandedGroups: new Set([luna.groupKey!]),
  }).lines);
  assert.ok(expanded.some(line => /^  ▾ Luna/.test(line)));
  assert.ok(expanded.some(line => /^    ✓ Explore/.test(line)));
  assert.ok(expanded.some(line => /^  ▸ Terra/.test(line)));
  assert.doesNotMatch(expanded.join('\n'), /✓ Review/);
});
