import assert from 'node:assert/strict';
import test from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import {
  renderPiFooter,
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
    location: { project: 'mpx2', worktree: 'feature-tree', branch: 'footer' },
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
  assert.match(text[0]!, /^New session · #12345678 · Personal$/);
  assert.ok(lines[0]!.includes('\x1b[38;2;71;127;204mPersonal\x1b[0m'));
  assert.match(text[1]!, /^claude-sonnet-4 · ◆◆◆◆◇◇$/);
  assert.equal(text[2], 'mpx2 · feature-tree · footer');
  assert.match(text[3]!, /42\.1k \(42%\)/);
  assert.doesNotMatch(text[3]!, /Context/);
  assert.match(text[3]!, /\$1\.250$/);
  assert.match(text[4]!, /^5h ██░░░░░░ 23% 1h$/);
  assert.doesNotMatch(text.join('\n'), /port|dirty|ahead|runtime/i);
});

test('thinkingGauge implements every original six-slot effort level', () => {
  assert.deepEqual(
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown'].map(level => stripTerminalSequences(thinkingGauge(level))),
    ['◇◇◇◇◇◇', '◆◇◇◇◇◇', '◆◆◇◇◇◇', '◆◆◆◇◇◇', '◆◆◆◆◇◇', '◆◆◆◆◆◇', '◆◆◆◆◆◆', '<unknown>'],
  );
});

test('unknown and nonfinite metrics are unavailable rather than fabricated zeroes', () => {
  const text = plain(renderPiFooter(snapshot({ account: undefined, contextTokens: Number.NaN, contextPercent: Number.NaN, cost: Infinity, quota: undefined }), 90, theme));
  assert.equal(text[0], 'New session · #12345678');
  assert.match(text[3]!, /unavailable.*cost unavailable/);
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

test('places finished agents right only when both columns remain readable', () => {
  const agents = Array.from({ length: 7 }, (_, index) => ({
    id: `agent-${index}`, type: `reviewer-${index}`, status: index === 6 ? 'completed' : 'failed',
    model: 'openai/gpt-5', effort: 'medium', elapsedMs: 65_000 + index * 1000,
  }));
  const wide = plain(renderPiFooter(snapshot({ agents }), 180, theme));
  assert.match(wide[0]!, /│ .*Finished agents/);
  assert.ok(wide.some(line => /… 2 earlier agents/.test(line)));
  assert.ok(wide.some(line => /✓ reviewer-6 · gpt-5 · ◆◆◆◇◇◇ · 1m 11s/.test(line)));
  assert.doesNotMatch(wide.join('\n'), /tokens/i);

  const narrow = plain(renderPiFooter(snapshot({ agents: agents.slice(-1) }), 60, theme));
  assert.equal(narrow.slice(0, 5).some(line => line.includes('reviewer-6')), false);
  assert.match(narrow[5]!, /Finished agents/);
  assert.match(narrow[6]!, /reviewer-6/);
  assertBounded(renderPiFooter(snapshot({ agents }), 180, theme), 180);
  assertBounded(renderPiFooter(snapshot({ agents }), 60, theme), 60);
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
  assert.match(text[0]!, /^Footer title · #12345678 · Work .*│/);
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
    assert.ok(line.includes('\x1b[90m │ \x1b[0m'));
  }
});

test('right-column links close OSC8 before padding and separator', () => {
  const lines = renderPiFooter(snapshot({
    agents: [{ id: 'a', type: 'reviewer', status: 'done', model: 'openai/gpt-5', effort: 'high', elapsedMs: 1000, url: 'https://example.test/agent' }],
  }), 180, theme);
  const linkedRow = lines.find(line => line.includes('https://example.test/agent'))!;
  assert.match(linkedRow, /\x1b]8;;\x1b\\(?: +)?$/);
  assertBounded(lines, 180);
});
