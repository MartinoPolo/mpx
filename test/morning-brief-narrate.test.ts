import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const narrateScript = resolve('content/skills/morning-brief/scripts/narrate.mjs');
const CLIP_SECONDS = 0.5;
const BYTES_PER_SECOND = 16_000;

type NarrateRun = { exitCode: number; stdout: string; stderr: string };
type FakeVoiceStudio = { url: string; spokenTexts: string[]; close: () => Promise<void> };
type Clips = Record<string, { audio: string; audioSeconds: number }>;

// A mono 16-bit PCM WAV of the given length, silent.
function silentWav(seconds: number): Buffer {
  const dataSize = Math.round(seconds * BYTES_PER_SECOND);
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(BYTES_PER_SECOND / 2, 24);
  wav.writeUInt32LE(BYTES_PER_SECOND, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

function listening(server: Server): Promise<string> {
  return new Promise((resolveUrl) => server.listen(0, '127.0.0.1', () => resolveUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const closing = (server: Server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()));

// Answers health checks and renders every requested sentence as silence, recording what it was asked to speak.
async function fakeVoiceStudio(): Promise<FakeVoiceStudio> {
  const spokenTexts: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/health') return void response.end('{"status":"ok"}');
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      spokenTexts.push(JSON.parse(body).input);
      response.writeHead(200, { 'content-type': 'audio/wav' }).end(silentWav(CLIP_SECONDS));
    });
  });
  const url = await listening(server);
  return { url, spokenTexts, close: () => closing(server) };
}

// An address nothing listens on.
async function deadBackendUrl(): Promise<string> {
  const server = createServer();
  const url = await listening(server);
  await closing(server);
  return url;
}

async function narrate(dayDirectory: string, backendUrl: string, ...flags: string[]): Promise<NarrateRun> {
  // Without a checkout to start, a backend that is not running fails at once and never reaches a GPU.
  const { VOICESTUDIO_DIR: _checkout, MPX_CLONED: _clones, ...environment } = process.env;
  try {
    const { stdout, stderr } = await exec(process.execPath, [narrateScript, dayDirectory, ...flags], {
      env: { ...environment, VOICESTUDIO_URL: backendUrl },
      timeout: 60_000,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function withDayDirectory<Result>(use: (dayDirectory: string) => Promise<Result>): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), 'mpx-narrate-'));
  try {
    const dayDirectory = join(root, '2026-11-18');
    await mkdir(dayDirectory);
    return await use(dayDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const writeJudgement = (dayDirectory: string, narration: Record<string, { text: string; targets: string[] }[]>) =>
  writeFile(join(dayDirectory, 'daily-brief.judgement.json'), JSON.stringify({ narration }));

const readClips = async (dayDirectory: string): Promise<Clips> => JSON.parse(await readFile(join(dayDirectory, 'daily-brief.clips.json'), 'utf8'));

test('the document narration is voiced up to the two kept sentences per chapter and an unchanged sentence keeps its clip', async () => {
  const voiceStudio = await fakeVoiceStudio();
  try {
    await withDayDirectory(async (dayDirectory) => {
      const calendar = [
        { text: 'The dentist at half past five shapes the day.', targets: ['2026-11-18'] },
        { text: 'Tomorrow is empty.', targets: ['2026-11-19'] },
        { text: 'A third sentence the document cuts.', targets: [] },
      ];
      const mail = [{ text: 'Two mails wait.', targets: ['personal'] }];
      await writeJudgement(dayDirectory, { calendar, mail });

      const first = await narrate(dayDirectory, voiceStudio.url, '--document');
      assert.equal(first.exitCode, 0, first.stderr);
      assert.deepEqual(voiceStudio.spokenTexts, [calendar[0]!.text, calendar[1]!.text, mail[0]!.text]);
      const clips = await readClips(dayDirectory);
      assert.deepEqual(Object.keys(clips), voiceStudio.spokenTexts);
      for (const clip of Object.values(clips)) {
        assert.match(clip.audio, /^[0-9a-f]{16}\.wav$/, 'a bare file name in audio/');
        assert.equal(clip.audioSeconds, CLIP_SECONDS);
        assert.ok(existsSync(join(dayDirectory, 'audio', clip.audio)));
      }
      assert.match(first.stdout, /voiced 3 of 3 narration sentences, 3 rendered/);
      assert.equal(existsSync(join(dayDirectory, 'brief.json')), false, 'the page data is not needed');

      await writeJudgement(dayDirectory, { calendar: [calendar[0]!, { text: 'Tomorrow brings the tax call.', targets: ['2026-11-19'] }], mail });
      const second = await narrate(dayDirectory, voiceStudio.url, '--document');
      assert.equal(second.exitCode, 0, second.stderr);
      assert.deepEqual(voiceStudio.spokenTexts.slice(3), ['Tomorrow brings the tax call.'], 'only the changed sentence is rendered');
      const rerunClips = await readClips(dayDirectory);
      assert.deepEqual(Object.keys(rerunClips), [calendar[0]!.text, 'Tomorrow brings the tax call.', mail[0]!.text]);
      assert.equal(rerunClips[calendar[0]!.text]!.audio, clips[calendar[0]!.text]!.audio);
    });
  } finally {
    await voiceStudio.close();
  }
});

test('without a backend the narration keeps only the clips rendered before and the script exits 2', async () => {
  const voiceStudio = await fakeVoiceStudio();
  try {
    await withDayDirectory(async (dayDirectory) => {
      const kept = { text: 'Two mails wait.', targets: ['personal'] };
      await writeJudgement(dayDirectory, { mail: [kept] });
      assert.equal((await narrate(dayDirectory, voiceStudio.url, '--document')).exitCode, 0);

      await writeJudgement(dayDirectory, { mail: [kept, { text: 'A new sentence.', targets: [] }] });
      const run = await narrate(dayDirectory, await deadBackendUrl(), '--document');
      assert.equal(run.exitCode, 2);
      assert.match(run.stderr, /VoiceStudio is not reachable at .* and could not be started/);
      assert.match(run.stdout, /voiced 1 of 2 narration sentences, 0 rendered/);
      assert.deepEqual(Object.keys(await readClips(dayDirectory)), [kept.text]);
    });
  } finally {
    await voiceStudio.close();
  }
});

test('the page beats are voiced with their audio path and a held beat stays silent', async () => {
  const voiceStudio = await fakeVoiceStudio();
  try {
    await withDayDirectory(async (dayDirectory) => {
      const briefPath = join(dayDirectory, 'brief.json');
      await writeFile(briefPath, JSON.stringify({ chapters: [
        { id: 'calendar', beats: [{ say: 'The dentist at half past five.', note: 'Dentist', targets: [] }] },
        { id: 'retro', beats: [{ say: '', note: 'Quiet', hold: 2 }] },
      ] }));
      const run = await narrate(dayDirectory, voiceStudio.url);
      assert.equal(run.exitCode, 0, run.stderr);
      const brief = JSON.parse(await readFile(briefPath, 'utf8'));
      const [voiced] = brief.chapters[0].beats;
      assert.match(voiced.audio, /^audio\/[0-9a-f]{16}\.wav$/);
      assert.equal(voiced.audioSeconds, CLIP_SECONDS);
      assert.deepEqual(brief.chapters[1].beats[0], { say: '', note: 'Quiet', hold: 2 });
      assert.deepEqual(brief.narration, { provider: 'voicestudio', voice: process.env.MORNING_BRIEF_VOICE ?? 'Morning brief', language: process.env.MORNING_BRIEF_LANGUAGE ?? 'en' });
      assert.equal(existsSync(join(dayDirectory, 'daily-brief.clips.json')), false);
    });
  } finally {
    await voiceStudio.close();
  }
});
