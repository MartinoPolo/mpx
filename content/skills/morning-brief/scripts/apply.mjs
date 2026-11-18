#!/usr/bin/env node
// Carries out the approved connector operations of one run folder: one headless cheap-model session per account,
// allowed only the write tools its operations need, behind apply-hook.mjs, which denies any call that differs
// from an approved one and records each answer. Writes result.json; exits 0 when every operation is done.
// Usage: apply.mjs <absolute run directory>   (run.json: { day, model?, operations: [{ id, account, kind, arguments }] })
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_LAUNCHERS, HEADLESS_MODEL, contentRoot, readEnvelope, runHeadless, sessionLog } from './headless.mjs';

const TIMEOUT_MILLISECONDS = 10 * 60 * 1000;
const OPERATION_TOOLS = {
  'gmail-send': 'mcp__claude_ai_Gmail__send_message',
  'gmail-draft': 'mcp__claude_ai_Gmail__create_draft',
  'calendar-event': 'mcp__claude_ai_Google_Calendar__create_event',
  'slack-send': 'mcp__claude_ai_Slack__slack_send_message',
  'slack-draft': 'mcp__claude_ai_Slack__slack_send_message_draft',
};

const [runDirectory] = process.argv.slice(2);
if (!runDirectory || !isAbsolute(runDirectory)) {
  console.error('Usage: apply.mjs <absolute run directory>');
  process.exit(1);
}
const run = JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8'));
const hookScript = join(dirname(fileURLToPath(import.meta.url)), 'apply-hook.mjs');
const forwardSlashes = (path) => path.replaceAll('\\', '/');
const readJson = async (path) => (existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : null);

function refusalOf(operation) {
  if (!(operation.kind in OPERATION_TOOLS)) return `Unknown operation kind ${operation.kind}.`;
  if (!(operation.account in ACCOUNT_LAUNCHERS)) return `Unknown account ${operation.account}.`;
  return null;
}

function settingsOf(account) {
  const hook = (stage) => [{ type: 'command', command: `node "${forwardSlashes(hookScript)}" ${stage} "${forwardSlashes(runDirectory)}" ${account}`, timeout: 30 }];
  return {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: hook('pre') }],
      PostToolUse: [{ matcher: '*', hooks: hook('post') }],
      PostToolUseFailure: [{ matcher: '*', hooks: hook('failure') }],
    },
  };
}

function promptOf(accountCalls) {
  return [
    'You carry out tool calls the user approved one by one in the brief review of the Alfred control center.',
    'A hook checks every call against this list and denies any call whose tool or input differs in a single character.',
    '',
    'For each call: load its tool with ToolSearch (`select:<tool>`), then call it once with exactly the given input.',
    'Do not change, correct, translate or reformat any value. Call no other tool. When a call is denied or fails,',
    'do not retry it; go on with the next one. When every call has been made, answer with {"finished": true} and nothing else.',
    '',
    '```json',
    JSON.stringify(accountCalls.map(({ tool, input }) => ({ tool, input })), null, 2),
    '```',
  ].join('\n');
}

async function applyAccount(account, accountCalls, cwd) {
  const settingsPath = join(runDirectory, `${account}.settings.json`);
  await writeFile(settingsPath, `${JSON.stringify(settingsOf(account), null, 2)}\n`);
  const outcome = await runHeadless({
    account,
    model: run.model ?? HEADLESS_MODEL,
    tools: [...new Set(accountCalls.map((call) => call.tool))],
    prompt: promptOf(accountCalls),
    cwd,
    timeoutMilliseconds: TIMEOUT_MILLISECONDS,
    settingsPath,
  });
  await writeFile(join(runDirectory, `${account}.log`), sessionLog(outcome));
  try {
    const envelope = readEnvelope(outcome, TIMEOUT_MILLISECONDS);
    return { status: 'finished', reason: null, costUsd: envelope.total_cost_usd ?? null };
  } catch (error) {
    return { status: 'failed', reason: error.message, costUsd: null };
  }
}

/**
 * An answer settles an operation. A claim without an answer is unknown: the tool may have acted. Without a claim
 * the tool never ran, but only a hook that logged its work proves it was active; otherwise the state is unknown.
 */
async function stateOf(call) {
  const answer = await readJson(join(runDirectory, 'answers', `${call.id}.json`));
  if (answer) return { state: answer.state, link: answer.link, reason: answer.reason };
  if (existsSync(join(runDirectory, 'started', `${call.id}.json`))) {
    return { state: 'unknown', link: null, reason: 'The call started but its answer never came; check the account.' };
  }
  if (existsSync(join(runDirectory, `${call.account}.hook.jsonl`))) return { state: 'failed', link: null, reason: 'The model never made this call.' };
  return { state: 'unknown', link: null, reason: 'The run ended without the hook confirming whether this call was made; check the account.' };
}

async function writeResult(accounts, operations) {
  await writeFile(join(runDirectory, 'result.json'), `${JSON.stringify({ day: run.day, finishedAt: new Date().toISOString(), accounts, operations }, null, 2)}\n`);
  for (const operation of operations) console.log(`${operation.id}: ${operation.state}${operation.reason ? ` (${operation.reason})` : ''}`);
  process.exitCode = operations.every((operation) => operation.state === 'done') ? 0 : 2;
}

async function applyCalls(sessionDirectory) {
  await writeFile(join(runDirectory, 'calls.json'), `${JSON.stringify(calls, null, 2)}\n`);
  await mkdir(join(runDirectory, 'started'), { recursive: true });
  await mkdir(join(runDirectory, 'answers'), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  const accounts = [...new Set(calls.map((call) => call.account))];
  const accountResults = await Promise.all(
    accounts.map(async (account) => [account, await applyAccount(account, calls.filter((call) => call.account === account), sessionDirectory)]),
  );
  const settled = await Promise.all(calls.map(async (call) => ({ id: call.id, ...(await stateOf(call)) })));
  await writeResult(Object.fromEntries(accountResults), [...refused, ...settled]);
}

const refused = run.operations.flatMap((operation) => {
  const reason = refusalOf(operation);
  return reason ? [{ id: operation.id, state: 'failed', link: null, reason }] : [];
});
const calls = run.operations
  .filter((operation) => !refused.some(({ id }) => id === operation.id))
  .map((operation) => ({ id: operation.id, account: operation.account, tool: OPERATION_TOOLS[operation.kind], input: operation.arguments }));
const retainedRoot = process.env.MPX_AI_RETAINED;
const preflightReason = !contentRoot()
  ? 'MPX_ACTIVE_CONTENT_ROOT is not set to the mpx checkout.'
  : !retainedRoot || !isAbsolute(retainedRoot)
    ? 'MPX_AI_RETAINED is not set.'
    : null;
if (preflightReason) {
  await writeResult({}, [...refused, ...calls.map((call) => ({ id: call.id, state: 'failed', link: null, reason: `Not started: ${preflightReason}` }))]);
} else {
  // A session under MPX_AI_RETAINED launches without the project ownership prompt a headless run cannot answer.
  await applyCalls(join(retainedRoot, 'morning-brief', run.day));
}
