#!/usr/bin/env node
// The hook of an apply.mjs session. Before a tool runs it passes ToolSearch and exactly one pending call of the
// account, claimed in started/<id>.json, and denies anything else; after the tool it records the answer in
// answers/<id>.json. Usage: apply-hook.mjs pre|post|failure <run directory> <account>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const LINK_KEYS = ['viewUrl', 'htmlLink', 'permalink', 'message_link', 'link', 'url', 'channel_link'];
const URL_PATTERN = /https?:\/\/[^\s"'\\<>]+/g;
const SEARCH_TOOL = 'ToolSearch';

const [stage, runDirectory, account] = process.argv.slice(2);
const hookInput = JSON.parse(readFileSync(0, 'utf8'));
const calls = JSON.parse(readFileSync(join(runDirectory, 'calls.json'), 'utf8')).filter((call) => call.account === account);
const startedPath = (call) => join(runDirectory, 'started', `${call.id}.json`);
const answerPath = (call) => join(runDirectory, 'answers', `${call.id}.json`);
const isRequested = (call) => call.tool === hookInput.tool_name && isDeepStrictEqual(call.input, hookInput.tool_input);

function log(entry) {
  appendFileSync(join(runDirectory, `${account}.hook.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), stage, tool: hookInput.tool_name, ...entry })}\n`);
}

/** Claims the first unclaimed call with these exact arguments; the `wx` flag makes a claim win only once. */
function claim() {
  for (const call of calls.filter(isRequested)) {
    try {
      writeFileSync(startedPath(call), JSON.stringify({ id: call.id, toolUseId: hookInput.tool_use_id ?? null, startedAt: new Date().toISOString() }), { flag: 'wx' });
      return call;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return null;
}

function claimedCall() {
  const unanswered = calls.filter((call) => existsSync(startedPath(call)) && !existsSync(answerPath(call)));
  return (
    unanswered.find((call) => hookInput.tool_use_id && JSON.parse(readFileSync(startedPath(call), 'utf8')).toolUseId === hookInput.tool_use_id) ??
    unanswered.find(isRequested) ??
    null
  );
}

/** Every address in a tool's answer with the field it sits in; connectors wrap their JSON in text blocks. */
function urlsByKey(value, key = '', found = []) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return urlsByKey(parsed, key, found);
    } catch {}
    found.push(...[...value.matchAll(URL_PATTERN)].map((match) => [key, match[0]]));
  } else if (Array.isArray(value)) for (const element of value) urlsByKey(element, key, found);
  else if (value && typeof value === 'object') for (const [childKey, element] of Object.entries(value)) urlsByKey(element, childKey, found);
  return found;
}

/** The link to what the tool made: a known link field first, else the first address in the answer. */
function linkOf(response) {
  const found = urlsByKey(response);
  return LINK_KEYS.map((key) => found.find(([foundKey]) => foundKey === key)?.[1]).find(Boolean) ?? found[0]?.[1] ?? null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

if (stage === 'pre') {
  if (hookInput.tool_name === SEARCH_TOOL) log({ decision: 'pass' });
  else {
    const call = claim();
    log({ decision: call ? 'pass' : 'deny', id: call?.id ?? null, toolInput: hookInput.tool_input });
    if (!call) {
      const pending = calls.filter((candidate) => candidate.tool === hookInput.tool_name && !existsSync(startedPath(candidate)));
      deny(
        pending.length > 0
          ? `Denied: the input differs from the approved call. Call ${hookInput.tool_name} with exactly one of these inputs: ${pending.map((candidate) => JSON.stringify(candidate.input)).join(' or ')}.`
          : `Denied: no approved call of ${hookInput.tool_name} is left in this run.`,
      );
    }
  }
} else {
  const call = claimedCall();
  log({ id: call?.id ?? null });
  if (call) {
    const answer =
      stage === 'post'
        ? { state: 'done', link: linkOf(hookInput.tool_response), reason: null, response: hookInput.tool_response ?? null }
        : { state: 'failed', link: null, reason: String(hookInput.error ?? 'The tool reported an error.'), response: null };
    writeFileSync(answerPath(call), `${JSON.stringify({ id: call.id, tool: call.tool, answeredAt: new Date().toISOString(), ...answer }, null, 2)}\n`);
  }
}
