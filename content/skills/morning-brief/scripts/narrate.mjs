#!/usr/bin/env node
// Voices every beat of <day>/brief.json with VoiceStudio into <day>/audio/ and records each clip's path and length on
// its beat. With --document it voices instead the sentences the daily brief document keeps of the judgement's
// narration and records each clip's file name and length by sentence text in <day>/daily-brief.clips.json, which
// daily-brief.mjs writes on the sentences. Clips are keyed by voice, language and text, so a rerun only renders changed
// sentences. When the backend is not running, it is started from the VoiceStudio checkout for this run and stopped
// afterwards, so nothing stays resident between briefs. Exit code 2 when the backend cannot start or a clip fails.
// Usage: narrate.mjs <day-directory> [--document] [--voice <profile id or name>] [--language <ISO 639-1>]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { DOCUMENT_CLIPS_FILE, JUDGEMENT_FILE, judgedSentences, NARRATION_SENTENCE_LIMIT } from './document-narration.mjs';

const DEFAULT_BACKEND = 'http://127.0.0.1:3900';
const DEFAULT_VOICE = 'Morning brief';
const DEFAULT_LANGUAGE = 'en';
const HEALTH_TIMEOUT_MILLISECONDS = 5000;
const STARTUP_TIMEOUT_MILLISECONDS = 180000;
const STARTUP_POLL_MILLISECONDS = 2000;
// The first request loads the model onto the GPU.
const REQUEST_TIMEOUT_MILLISECONDS = 300000;
const RETRY_ATTEMPTS = 5;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { document: { type: 'boolean' }, voice: { type: 'string' }, language: { type: 'string' } },
});
const [dayDirectory] = positionals;
if (!dayDirectory || !isAbsolute(dayDirectory)) {
  console.error('Usage: narrate.mjs <absolute day directory> [--document] [--voice <profile id or name>] [--language <code>]');
  process.exit(1);
}
const backend = (process.env.VOICESTUDIO_URL ?? DEFAULT_BACKEND).replace(/\/$/, '');
const voiceStudioDirectory = process.env.VOICESTUDIO_DIR ?? (process.env.MPX_CLONED && join(process.env.MPX_CLONED, 'VoiceStudio'));
const voice = values.voice ?? process.env.MORNING_BRIEF_VOICE ?? DEFAULT_VOICE;
const language = values.language ?? process.env.MORNING_BRIEF_LANGUAGE ?? DEFAULT_LANGUAGE;
const readJson = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
const briefPath = join(dayDirectory, 'brief.json');
const brief = values.document ? undefined : await readJson(briefPath);
const judgement = values.document ? await readJson(join(dayDirectory, JUDGEMENT_FILE)) : undefined;
await mkdir(join(dayDirectory, 'audio'), { recursive: true });

const exists = (path) => access(path).then(() => true, () => false);
const beats = brief ? brief.chapters.flatMap((chapter) => (chapter.beats ?? []).filter((beat) => beat.say && !beat.hold)) : [];
const sentenceTexts = judgement
  ? Object.keys(judgement.narration ?? {}).flatMap((chapterName) => judgedSentences(judgement, chapterName).slice(0, NARRATION_SENTENCE_LIMIT))
    .map((sentence) => sentence?.text).filter((text) => typeof text === 'string' && text.trim())
  : [];
const texts = [...new Set(brief ? beats.map((beat) => beat.say) : sentenceTexts)];
const spokenUnit = brief ? 'beats' : 'narration sentences';
const clipName = (text) => `${createHash('sha256').update(`voicestudio\n${voice}\n${language}\n${text}`).digest('hex').slice(0, 16)}.wav`;
const clipPathOf = (text) => join(dayDirectory, 'audio', clipName(text));

async function healthy() {
  try {
    return (await fetch(`${backend}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MILLISECONDS) })).ok;
  } catch {
    return false;
  }
}

// uv starts uvicorn as its own child, and on Windows killing uv alone leaves uvicorn holding the port.
function stopTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-child.pid, 'SIGTERM');
}

async function startBackend() {
  if (!voiceStudioDirectory) throw new Error('set VOICESTUDIO_DIR or MPX_CLONED to start it');
  const { hostname, port } = new URL(backend);
  const log = openSync(join(dayDirectory, 'voicestudio.log'), 'w');
  const child = spawn('uv', ['run', 'uvicorn', 'main:app', '--app-dir', 'backend', '--host', hostname, '--port', port || '80'], {
    cwd: voiceStudioDirectory,
    stdio: ['ignore', log, log],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let exitReason;
  child.on('exit', (code) => { exitReason = `exit code ${code}`; });
  child.on('error', (error) => { exitReason = error.message; });
  const deadline = Date.now() + STARTUP_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline && exitReason === undefined) {
    if (await healthy()) return child;
    await delay(STARTUP_POLL_MILLISECONDS);
  }
  if (exitReason === undefined) stopTree(child);
  throw new Error(exitReason ?? `not healthy after ${STARTUP_TIMEOUT_MILLISECONDS / 1000} s`);
}

function wavSeconds(wav) {
  let offset = 12;
  let byteRate;
  while (offset + 8 <= wav.length) {
    const chunk = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (chunk === 'fmt ') byteRate = wav.readUInt32LE(offset + 16);
    if (chunk === 'data' && byteRate) return Math.min(size, wav.length - offset - 8) / byteRate;
    offset += 8 + size + (size % 2);
  }
  throw new Error('response is not a WAV file');
}

async function render(text) {
  let response;
  for (let attempt = 1; ; attempt++) {
    response = await fetch(`${backend}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice, language, input: text, response_format: 'wav' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    });
    // A freshly started backend runs its own warm-up job and refuses work until the GPU frees up.
    if (response.headers.get('x-omnivoice-retryable') !== 'true' || attempt === RETRY_ATTEMPTS) break;
    await response.body?.cancel();
    await delay(Number(response.headers.get('retry-after') ?? 30) * 1000);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const wav = Buffer.from(await response.arrayBuffer());
  wavSeconds(wav);
  await writeFile(clipPathOf(text), wav);
}

async function clipOf(text) {
  return { file: clipName(text), seconds: Math.round(wavSeconds(await readFile(clipPathOf(text))) * 100) / 100 };
}

const missing = [];
for (const text of texts) if (!(await exists(clipPathOf(text)))) missing.push(text);
const failures = [];
let startedBackend;
let backendReachable = !missing.length || (await healthy());
if (!backendReachable) {
  try {
    startedBackend = await startBackend();
    backendReachable = true;
  } catch (error) {
    failures.push(`VoiceStudio is not reachable at ${backend} and could not be started (${error.message}, see voicestudio.log); only clips rendered before are used.`);
  }
}

// One GPU renders one clip at a time, so requests run in order.
const clips = new Map();
try {
  for (const text of texts) {
    try {
      if (missing.includes(text)) {
        if (!backendReachable) continue;
        await render(text);
      }
      clips.set(text, await clipOf(text));
    } catch (error) {
      failures.push(`"${text.slice(0, 40)}": ${error.message}`);
    }
  }
} finally {
  if (startedBackend) stopTree(startedBackend);
}

if (brief) {
  for (const beat of beats) {
    const clip = clips.get(beat.say);
    if (clip) Object.assign(beat, { audio: `audio/${clip.file}`, audioSeconds: clip.seconds });
    else { delete beat.audio; delete beat.audioSeconds; }
  }
  brief.narration = { provider: 'voicestudio', voice, language };
  await writeFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
} else {
  const clipsByText = Object.fromEntries([...clips].map(([text, clip]) => [text, { audio: clip.file, audioSeconds: clip.seconds }]));
  await writeFile(join(dayDirectory, DOCUMENT_CLIPS_FILE), `${JSON.stringify(clipsByText, null, 2)}\n`);
}
const totalSeconds = [...clips.values()].reduce((total, clip) => total + clip.seconds, 0);
const rendered = missing.filter((text) => clips.has(text)).length;
const started = startedBackend ? ', backend started and stopped for this run' : '';
console.log(`voiced ${clips.size} of ${texts.length} ${spokenUnit}, ${rendered} rendered${started}, ${Math.round(totalSeconds)} s, ${texts.reduce((total, text) => total + text.length, 0)} characters`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(2);
}
