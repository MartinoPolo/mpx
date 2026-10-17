#!/usr/bin/env node
// Voices every beat of <day>/brief.json with ElevenLabs into <day>/audio/ and records each clip's
// path and length on its beat. Clips are keyed by voice, model and text, so a rerun only pays for
// changed sentences. Usage: narrate.mjs <day-directory> [--voice <id>] [--model <id>]
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';

const DEFAULT_VOICE = 'Xb7hH8MSUJpSbSDYk0k2';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const REQUEST_TIMEOUT_MILLISECONDS = 60000;
const PARALLEL_REQUESTS = 3;

const { positionals, values } = parseArgs({ allowPositionals: true, options: { voice: { type: 'string' }, model: { type: 'string' } } });
const [dayDirectory] = positionals;
if (!dayDirectory || !isAbsolute(dayDirectory)) {
  console.error('Usage: narrate.mjs <absolute day directory> [--voice <id>] [--model <id>]');
  process.exit(1);
}
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is not set; the page will use the browser voice.');
  process.exit(2);
}
const voice = values.voice ?? process.env.MORNING_BRIEF_VOICE ?? DEFAULT_VOICE;
const model = values.model ?? process.env.MORNING_BRIEF_VOICE_MODEL ?? DEFAULT_MODEL;
const briefPath = join(dayDirectory, 'brief.json');
const brief = JSON.parse(await readFile(briefPath, 'utf8'));
await mkdir(join(dayDirectory, 'audio'), { recursive: true });

const exists = (path) => access(path).then(() => true, () => false);
const beats = brief.chapters.flatMap((chapter) => (chapter.beats ?? []).filter((beat) => beat.say && !beat.hold));

async function synthesize(beat, index) {
  const key = createHash('sha256').update(`${voice}\n${model}\n${beat.say}`).digest('hex').slice(0, 16);
  const clipPath = join(dayDirectory, 'audio', `${key}.mp3`);
  const metaPath = join(dayDirectory, 'audio', `${key}.json`);
  if (!(await exists(clipPath)) || !(await exists(metaPath))) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      // Neighbouring sentences keep intonation continuous across clips.
      body: JSON.stringify({ text: beat.say, model_id: model, previous_text: beats[index - 1]?.say, next_text: beats[index + 1]?.say }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const result = await response.json();
    const seconds = result.alignment?.character_end_times_seconds?.at(-1);
    await writeFile(clipPath, Buffer.from(result.audio_base64, 'base64'));
    await writeFile(metaPath, JSON.stringify({ seconds, text: beat.say }));
  }
  const { seconds } = JSON.parse(await readFile(metaPath, 'utf8'));
  beat.audio = `audio/${key}.mp3`;
  if (seconds) beat.audioSeconds = Math.round(seconds * 100) / 100;
}

const failures = [];
for (let start = 0; start < beats.length; start += PARALLEL_REQUESTS) {
  await Promise.all(beats.slice(start, start + PARALLEL_REQUESTS).map((beat, offset) =>
    synthesize(beat, start + offset).catch((error) => { delete beat.audio; delete beat.audioSeconds; failures.push(`"${beat.say.slice(0, 40)}": ${error.message}`); })));
}
brief.narration = { provider: 'elevenlabs', voice, model };
await writeFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
const voiced = beats.filter((beat) => beat.audio).length;
const totalSeconds = beats.reduce((total, beat) => total + (beat.audioSeconds ?? 0), 0);
console.log(`voiced ${voiced} of ${beats.length} beats, ${Math.round(totalSeconds)} s, ${beats.reduce((total, beat) => total + beat.say.length, 0)} characters`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(2);
}
