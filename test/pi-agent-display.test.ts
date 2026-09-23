import assert from 'node:assert/strict';
import test from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { finishedAgentFromRecord, renderLiveAgents, savedFinishedAgents, type LiveAgent } from '../src/pi-agent-display.js';

const theme = { fg: (_color: string, text: string) => text };
const taggedTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
const saved = {
  id: 'one', type: 'Explore', status: 'completed', parentSessionId: 'parent',
  invocation: { modelId: 'gpt-6-luna', thinking: 'high' }, startedAt: 100, completedAt: 600,
  lifetimeUsage: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, cost: 0.25 },
};

test('saved history restores exact model, effort, lifetime cost, and leaves peak input unknown', () => {
  assert.deepEqual(finishedAgentFromRecord(saved, 'parent'), {
    id: 'one', type: 'Explore', status: 'completed', model: 'gpt-6-luna', effort: 'high',
    elapsedMs: 500, cost: 0.25,
  });
  const withoutUsage = finishedAgentFromRecord({ ...saved, invocation: undefined, lifetimeUsage: undefined }, 'parent');
  assert.equal(withoutUsage?.peakInputTokens, undefined);
  assert.equal(withoutUsage?.cost, undefined);
  assert.equal(withoutUsage?.model, undefined);
  for (const cost of [undefined, 0, -1, Infinity, NaN]) {
    assert.equal(finishedAgentFromRecord({ ...saved, lifetimeUsage: { ...saved.lifetimeUsage, cost } }, 'parent')?.cost, undefined);
  }
});

test('saved history deduplicates snapshots and excludes other parents and nested agents', () => {
  const entry = (data: unknown) => ({ type: 'custom', customType: 'subagents:record', data });
  const history = savedFinishedAgents([
    entry({ ...saved, status: 'running' }), entry(saved), entry({ ...saved, parentSessionId: 'another' }),
    entry({ ...saved, id: 'nested', parentAgentId: 'one' }), entry({ ...saved, id: 'workflow', workflowId: 'flow' }),
    entry({ ...saved, id: 'interrupted', status: 'queued', completedAt: undefined }), entry(null),
    { type: 'custom', customType: 'unrelated', data: saved },
  ], 'parent');
  assert.equal(history.length, 2);
  assert.equal(history[0]?.status, 'completed');
  assert.equal(history[1]?.status, 'stopped');
});

test('live widget is empty when idle, collapses queued work and bounds running rows', () => {
  assert.deepEqual(renderLiveAgents([], 80, theme), []);
  const agents: LiveAgent[] = Array.from({ length: 9 }, (_, index) => ({
    id: String(index), type: `agent-${index}`, status: index < 7 ? 'running' : 'queued',
    description: 'Inspect code', model: 'Luna', effort: 'low',
  }));
  const lines = renderLiveAgents(agents, 80, theme).map(stripTerminalSequences);
  assert.equal(lines[0], 'Agents · 7 running · 2 queued');
  assert.equal(lines.length, 7);
  assert.equal(lines.at(-1), '… 2 more running');
  assert.doesNotMatch(lines.join('\n'), /agent-5|agent-6|agent-7|agent-8/);
  assert.deepEqual(renderLiveAgents([{ id: 'queue', type: 'Explore', status: 'queued' }], 80, theme), ['Agents · 0 running · 1 queued']);
});

test('live agent names and model names follow model tier colors', () => {
  const agents: LiveAgent[] = [
    { id: 'a', type: 'AstraAgent', status: 'running', model: 'gpt-6-astra' },
    { id: 's', type: 'SolAgent', status: 'running', model: 'gpt-6-sol' },
    { id: 'l', type: 'LunaAgent', status: 'running', model: 'gpt-6-luna' },
    { id: 't', type: 'TerraAgent', status: 'running', model: 'gpt-6-terra' },
  ];
  const output = renderLiveAgents(agents, 200, taggedTheme).join('\n');
  assert.match(output, /\x1b\[38;5;48mAstraAgent\x1b\[0m.*\x1b\[38;5;48mAstra 6\x1b\[0m/);
  assert.match(output, /\x1b\[38;5;39mSolAgent\x1b\[0m.*\x1b\[38;5;39mSol 6\x1b\[0m/);
  assert.match(output, /\x1b\[38;5;226mLunaAgent\x1b\[0m.*\x1b\[38;5;226mLuna 6\x1b\[0m/);
  assert.match(output, /\x1b\[38;5;208mTerraAgent\x1b\[0m.*\x1b\[38;5;208mTerra 6\x1b\[0m/);
  assert.match(renderLiveAgents([{ id: 'codex', type: 'Worker', status: 'running',
    model: 'chatgpt-codex/codex-6-sol' }], 120, theme).join(''), /Sol 6/);
});

test('live rows sanitize untrusted text and stay within terminal width', () => {
  const agents: LiveAgent[] = [{ id: 'one', type: '\u001b[31mExplore\n', status: 'running', description: '界'.repeat(60) }];
  for (const width of [1, 8, 40, 80]) {
    const lines = renderLiveAgents(agents, width, theme);
    assert.ok(lines.every(line => visibleWidth(line) <= width && !line.includes('\n')));
  }
});
