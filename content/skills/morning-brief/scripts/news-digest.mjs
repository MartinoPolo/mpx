#!/usr/bin/env node
// Digests <day>/sources/news.json in one headless session of the cheapest tier without tools, following the news taste in
// <day>/../taste.md: the lead, the new model releases (one per product, the newest), a summary of each and at most one
// narration sentence, every pick one of the candidates by its link. A refused answer is asked for once more. Writes
// <day>/sources/news-digest.json, `ok` with the picks or `failed` with the reason, and the session in news-digest.log.
// Exit code 2 when the digest failed: the document then shows the candidates' picks without summaries.
// Usage: news-digest.mjs <day-directory> [--model <model>] [--account personal|work]
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { NEWS_DIGEST_FILE, NEWS_FILE } from './document-narration.mjs';
import { ACCOUNT_LAUNCHERS, contentRoot, extractJson, readEnvelope, runHeadless, sessionLog } from './headless.mjs';

// Picking from a short list needs little reasoning, so the cheapest tier does it.
const DIGEST_MODEL = 'haiku';
const TIMEOUT_MILLISECONDS = 3 * 60 * 1000;
const MAXIMUM_RELEASES = 5;
const MAXIMUM_SUMMARY_CHARACTERS = 280;
const MAXIMUM_NARRATION_CHARACTERS = 200;
const SYSTEM_PROMPT = `You pick the AI news for one reader's morning brief from candidates given as JSON. Answer with one JSON object and nothing else:
{"lead": {"link": "...", "summary": "..."} or null, "releases": [{"link": "...", "summary": "..."}], "narration": {"text": "...", "links": ["..."]} or null}
- lead: the one story that matters most today to someone who builds with AI coding agents such as Claude Code and Codex; null when none stands out.
- releases: each AI model newly released or announced (a model, not a product feature), then a Claude Code, Codex or Gemini CLI release only when it changes how a daily user works; at most ${MAXIMUM_RELEASES}, newest first, never the lead again; at most one release per product: of several versions pick the newest, whose summary may say it follows the earlier ones.
- summary: one or two short sentences in plain words on what changed and why it matters, taken only from the candidates' titles and excerpts (one story may appear in several); at most ${MAXIMUM_SUMMARY_CHARACTERS} characters; null when they say no more than the title.
- narration: at most one short spoken sentence for the whole chapter, without links or symbols, and the links of the picks it names; null when nothing is worth saying.
- Every link is copied exactly from a candidate. Never add a story, number or fact the candidates do not contain.
- The reader's taste comes first where it speaks about news.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { model: { type: 'string', default: DIGEST_MODEL }, account: { type: 'string', default: 'personal' } },
});
const [dayDirectory] = positionals;
if (!dayDirectory || !isAbsolute(dayDirectory) || !(values.account in ACCOUNT_LAUNCHERS)) {
  console.error('Usage: news-digest.mjs <absolute day directory> [--model <model>] [--account personal|work]');
  process.exit(1);
}
let news;
try {
  news = JSON.parse((await readFile(join(dayDirectory, NEWS_FILE), 'utf8')).replace(/^﻿/, ''));
} catch (error) {
  console.error(`No readable ${NEWS_FILE} (${error.message}); run news.mjs first.`);
  process.exit(2);
}
const taste = await readFile(join(dayDirectory, '..', 'taste.md'), 'utf8').catch(() => '');
const candidateLinks = new Set(news.candidates.map((candidate) => candidate.link));
const digestPath = join(dayDirectory, NEWS_DIGEST_FILE);

const isText = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

// Why an answer cannot stand, or null when every pick is a candidate with a summary.
function refusalOf(answer) {
  if (typeof answer !== 'object' || answer === null) return 'the answer is not a JSON object';
  const { lead = null, releases = [], narration = null } = answer;
  if (!Array.isArray(releases) || releases.length > MAXIMUM_RELEASES) return `releases must be a list of at most ${MAXIMUM_RELEASES}`;
  const picks = [...(lead === null ? [] : [lead]), ...releases];
  for (const pick of picks) {
    if (!candidateLinks.has(pick?.link)) return `${JSON.stringify(pick?.link)} is not the link of a candidate`;
    if (pick.summary !== null && !isText(pick.summary, MAXIMUM_SUMMARY_CHARACTERS)) return `the summary of ${pick.link} is neither null nor text of at most ${MAXIMUM_SUMMARY_CHARACTERS} characters`;
  }
  const pickedLinks = picks.map((pick) => pick.link);
  if (new Set(pickedLinks).size !== pickedLinks.length) return 'a candidate is picked twice';
  if (narration === null) return null;
  if (!isText(narration.text, MAXIMUM_NARRATION_CHARACTERS) || /https?:/.test(narration.text)) return `the narration must be one short sentence without links`;
  if (!Array.isArray(narration.links) || narration.links.some((link) => !pickedLinks.includes(link))) return 'the narration names a link that is not a pick';
  return null;
}

// One release per release source, its newest version; the narration names the version that stays.
function oneReleasePerProduct(releases, narration) {
  const candidatesByLink = new Map(news.candidates.map((candidate) => [candidate.link, candidate]));
  const newestBySource = new Map();
  for (const pick of releases) {
    const candidate = candidatesByLink.get(pick.link);
    if (candidate.kind !== 'release') continue;
    const newest = newestBySource.get(candidate.source);
    if (!newest || Date.parse(candidate.publishedAt) > Date.parse(candidatesByLink.get(newest.link).publishedAt)) newestBySource.set(candidate.source, pick);
  }
  const keptLinkByLink = new Map();
  const kept = releases.filter((pick) => {
    const candidate = candidatesByLink.get(pick.link);
    const newest = candidate.kind === 'release' ? newestBySource.get(candidate.source) : pick;
    if (newest === pick) return true;
    keptLinkByLink.set(pick.link, newest.link);
    console.log(`Left out ${candidate.title}, as ${candidatesByLink.get(newest.link).title} is newer.`);
    return false;
  });
  if (narration === null) return { releases: kept, narration };
  const links = [...new Set(narration.links.map((link) => keptLinkByLink.get(link) ?? link))];
  return { releases: kept, narration: { ...narration, links } };
}

async function writeDigest(digest) {
  await writeFile(digestPath, `${JSON.stringify(digest, null, 2)}\n`);
}

const input = [
  taste.trim() ? `The reader's taste:\n\n${taste.trim()}\n` : 'The reader has written no taste yet.\n',
  'The candidates:',
  JSON.stringify(news.candidates.map(({ app, ...candidate }) => candidate)),
].join('\n');
const run = { model: values.model, account: values.account, inputCharacters: SYSTEM_PROMPT.length + input.length };
if (news.candidates.length === 0) {
  await writeDigest({ status: 'ok', reason: 'No candidates, so no model ran.', ...run, inputCharacters: 0, lead: null, releases: [], narration: null });
  console.log('No news candidates; nothing to digest.');
  process.exit(0);
}
if (!contentRoot()) {
  await writeDigest({ status: 'failed', reason: 'MPX_ACTIVE_CONTENT_ROOT is not set; launch through cc or ccw.', ...run });
  console.error('MPX_ACTIVE_CONTENT_ROOT is not set; launch through cc or ccw.');
  process.exit(2);
}

const logs = [];
let prompt = input;
let digest;
for (let attempt = 1; attempt <= 2 && !digest; attempt++) {
  const outcome = await runHeadless({ account: values.account, model: values.model, tools: [], systemPrompt: SYSTEM_PROMPT, prompt, cwd: dayDirectory, timeoutMilliseconds: TIMEOUT_MILLISECONDS });
  logs.push(`--- attempt ${attempt} ---\n${sessionLog(outcome)}`);
  let envelope;
  try {
    envelope = readEnvelope(outcome, TIMEOUT_MILLISECONDS);
  } catch (error) {
    digest = { status: 'failed', reason: `the session failed: ${error.message}`, ...run, attempts: attempt };
    break;
  }
  const usage = envelope.usage ?? {};
  const measured = { ...run, attempts: attempt, inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), costUsd: envelope.total_cost_usd ?? null, durationMilliseconds: outcome.durationMilliseconds };
  let answer;
  let refusal;
  try {
    answer = extractJson(String(envelope.result ?? ''));
    refusal = refusalOf(answer);
  } catch (error) {
    refusal = `the answer is not JSON: ${error.message}`;
  }
  if (!refusal) {
    digest = { status: 'ok', reason: null, ...measured, lead: answer.lead ?? null, ...oneReleasePerProduct(answer.releases ?? [], answer.narration ?? null) };
  } else if (attempt === 2) {
    digest = { status: 'failed', reason: `the answer was refused twice, last because ${refusal}`, ...measured };
  } else {
    prompt = `${input}\n\nYour previous answer was refused because ${refusal}. Answer again with the JSON object only.`;
  }
}
await writeFile(join(dayDirectory, 'sources', 'news-digest.log'), logs.join('\n'));
await writeDigest(digest);
console.log(digest.status === 'ok'
  ? `News digest: ${digest.lead ? 1 : 0} lead, ${digest.releases.length} releases, ${digest.narration ? 1 : 0} narration sentence; ${digest.inputCharacters} input characters, ${digest.inputTokens} input tokens, ${digest.attempts} attempt(s).`
  : `News digest failed: ${digest.reason}`);
process.exit(digest.status === 'ok' ? 0 : 2);
