import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const applyScript = resolve('content/skills/morning-brief/scripts/apply.mjs');

// Stands in for a headless Claude session: it runs the session's hooks around each call listed in the prompt the
// way Claude Code does, and FAKE_MODEL_SCENARIO decides how the model and the tools behave.
const FAKE_MODEL = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const scenario = process.env.FAKE_MODEL_SCENARIO;
const log = (entry) => appendFileSync(process.env.FAKE_MODEL_LOG, JSON.stringify(entry) + '\n');
const prompt = readFileSync(0, 'utf8');
const fence = String.fromCharCode(96).repeat(3);
const calls = JSON.parse(prompt.slice(prompt.indexOf(fence + 'json') + 7, prompt.lastIndexOf(fence)));
const settings = JSON.parse(readFileSync(option('--settings'), 'utf8'));
log({ args, cwd: process.cwd() });
function runHooks(event, payload) {
  const answers = settings.hooks[event].flatMap(({ hooks }) => hooks.map(({ command }) =>
    spawnSync('bash', ['-c', command], { input: JSON.stringify({ hook_event_name: event, ...payload }), encoding: 'utf8' }).stdout.trim()));
  return answers.filter(Boolean).map((answer) => JSON.parse(answer)).find((answer) => answer.hookSpecificOutput?.permissionDecision === 'deny') ?? null;
}
let sequence = 0;
for (const { tool, input } of calls) {
  sequence += 1;
  const toolUseId = 'toolu_' + sequence;
  const sentInput = scenario === 'altered' ? JSON.parse(JSON.stringify(input).replace(/"(body|message|summary)":"/, '"$1":"Altered ')) : input;
  runHooks('PreToolUse', { tool_name: 'ToolSearch', tool_input: { query: 'select:' + tool }, tool_use_id: 'search_' + sequence });
  const attempts = scenario === 'twice' ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const denial = runHooks('PreToolUse', { tool_name: tool, tool_input: sentInput, tool_use_id: toolUseId + '_' + attempt });
    if (denial) {
      log({ tool, denied: denial.hookSpecificOutput.permissionDecisionReason });
      continue;
    }
    if (scenario === 'crash') process.exit(1);
    if (scenario === 'failure') runHooks('PostToolUseFailure', { tool_name: tool, tool_input: sentInput, tool_use_id: toolUseId + '_' + attempt, error: 'channel_not_found' });
    else {
      const answer = { id: 'answer-' + sequence, viewUrl: 'https://example.invalid/answer/' + sequence };
      runHooks('PostToolUse', { tool_name: tool, tool_input: sentInput, tool_use_id: toolUseId + '_' + attempt, tool_response: [{ type: 'text', text: JSON.stringify(answer) }] });
    }
  }
}
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{"finished": true}', total_cost_usd: 0.001 }));
`;

const MAIL_SEND = {
  id: 'reply-ivana',
  account: 'personal',
  kind: 'gmail-send',
  arguments: { to: ['ivana@example.invalid'], subject: 'Re: Saturday', body: 'Saturday works, see you at ten.', replyThreadId: 'thread-1' },
};
const CALENDAR_EVENT = {
  id: 'event-dentist',
  account: 'personal',
  kind: 'calendar-event',
  arguments: { summary: 'Dentist', startTime: '2026-11-19T09:00:00', endTime: '2026-11-19T10:00:00' },
};
const SLACK_SEND = {
  id: 'slack-freeze',
  account: 'work',
  kind: 'slack-send',
  arguments: { channel_id: 'C0RELEASE', message: 'Freeze moves to Thursday.', thread_ts: '1763400000.000100' },
};

type Operation = typeof MAIL_SEND | typeof CALENDAR_EVENT | typeof SLACK_SEND | { id: string; account: string; kind: string; arguments: object };

interface Applied {
  exitCode: number;
  result: { operations: { id: string; state: string; link: string | null; reason: string | null }[] };
  modelRuns: { args: string[]; cwd: string }[];
  denials: { tool: string; denied: string }[];
  runDirectory: string;
}

async function apply(operations: Operation[], scenario: string, check: (applied: Applied) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'mpx-morning-brief-apply-'));
  try {
    const contentRoot = join(root, 'mpx');
    const runDirectory = join(root, 'data', 'brief', '2026-11-18', 'runs', 'run-1');
    const modelLog = join(root, 'model.jsonl');
    await mkdir(join(contentRoot, 'bin'), { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(root, 'fake-claude.mjs'), FAKE_MODEL);
    const launcher = `#!/usr/bin/env bash\nexec node "${join(root, 'fake-claude.mjs').replaceAll('\\', '/')}" "$@"\n`;
    await writeFile(join(contentRoot, 'bin', 'cc'), launcher);
    await writeFile(join(contentRoot, 'bin', 'ccw'), launcher);
    await writeFile(modelLog, '');
    await writeFile(join(runDirectory, 'run.json'), JSON.stringify({ day: '2026-11-18', model: 'haiku', operations }));
    const env = { ...process.env, MPX_ACTIVE_CONTENT_ROOT: contentRoot, MPX_AI_RETAINED: join(root, 'retained'), FAKE_MODEL_SCENARIO: scenario, FAKE_MODEL_LOG: modelLog };
    const exitCode = await new Promise<number>((resolveExit) => {
      execFile(process.execPath, [applyScript, runDirectory], { env, timeout: 60_000 }, (error) => resolveExit(error ? Number(error.code) : 0));
    });
    const modelEntries = (await readFile(modelLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    await check({
      exitCode,
      result: JSON.parse(await readFile(join(runDirectory, 'result.json'), 'utf8')),
      modelRuns: modelEntries.filter((entry) => entry.args),
      denials: modelEntries.filter((entry) => entry.denied),
      runDirectory,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const optionOf = (args: string[], name: string) => args[args.indexOf(name) + 1];

test('each account runs once with only the write tools its operations need, and every answer is recorded', async () => {
  await apply([MAIL_SEND, CALENDAR_EVENT, SLACK_SEND], 'exact', ({ exitCode, result, modelRuns, denials }) => {
    assert.equal(exitCode, 0);
    assert.deepEqual(denials, []);
    assert.deepEqual(
      result.operations.map(({ id, state, link }) => [id, state, link?.startsWith('https://example.invalid/answer/')]),
      [['reply-ivana', 'done', true], ['event-dentist', 'done', true], ['slack-freeze', 'done', true]],
    );
    const allowedTools = modelRuns.map((run) => optionOf(run.args, '--allowedTools')).sort();
    assert.deepEqual(allowedTools, [
      'ToolSearch,mcp__claude_ai_Gmail__send_message,mcp__claude_ai_Google_Calendar__create_event',
      'ToolSearch,mcp__claude_ai_Slack__slack_send_message',
    ]);
    assert.ok(modelRuns.every((run) => optionOf(run.args, '--model') === 'haiku'));
    assert.ok(modelRuns.every((run) => run.cwd.replaceAll('\\', '/').endsWith('retained/morning-brief/2026-11-18')));
  });
});

test('a call whose words differ from the approved operation is denied and never runs', async () => {
  await apply([MAIL_SEND], 'altered', async ({ exitCode, result, denials, runDirectory }) => {
    assert.equal(exitCode, 2);
    assert.deepEqual(result.operations, [{ id: 'reply-ivana', state: 'failed', link: null, reason: 'The model never made this call.' }]);
    assert.equal(denials.length, 1);
    assert.match(denials[0]!.denied, /differs from the approved call/);
    assert.ok(denials[0]!.denied.includes(JSON.stringify(MAIL_SEND.arguments)), 'the denial names the approved input');
    const hookLog = await readFile(join(runDirectory, 'personal.hook.jsonl'), 'utf8');
    assert.match(hookLog, /"decision":"deny"/);
  });
});

test('an approved call runs once; the same call again is denied', async () => {
  await apply([SLACK_SEND], 'twice', ({ exitCode, result, denials }) => {
    assert.equal(exitCode, 0);
    assert.equal(result.operations[0]!.state, 'done');
    assert.deepEqual(denials.map((denial) => denial.denied), ['Denied: no approved call of mcp__claude_ai_Slack__slack_send_message is left in this run.']);
  });
});

test('a call that started without an answer before the run ended is unknown', async () => {
  await apply([MAIL_SEND], 'crash', ({ exitCode, result }) => {
    assert.equal(exitCode, 2);
    assert.equal(result.operations[0]!.state, 'unknown');
  });
});

test('a tool error and an unknown operation kind fail with their reasons', async () => {
  const unknownKind = { id: 'post-card', account: 'personal', kind: 'postcard-send', arguments: {} };
  await apply([SLACK_SEND, unknownKind], 'failure', ({ exitCode, result }) => {
    assert.equal(exitCode, 2);
    assert.deepEqual(
      result.operations.map(({ id, state, reason }) => [id, state, reason]),
      [['post-card', 'failed', 'Unknown operation kind postcard-send.'], ['slack-freeze', 'failed', 'channel_not_found']],
    );
  });
});
