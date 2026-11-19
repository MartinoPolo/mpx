import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLIP_SECONDS, deadBackendUrl, fakeVoiceStudio, narrate } from './morning-brief-voice-studio.js';

type Clips = Record<string, { audio: string; audioSeconds: number }>;

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

      const first = await narrate(dayDirectory, voiceStudio.url);
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
      assert.equal(existsSync(join(dayDirectory, 'brief.json')), false, 'brief.json is not needed');
      assert.match(await readFile(join(dayDirectory, 'narrate.log'), 'utf8'), /^voiced 3 of 3 narration sentences/);

      await writeJudgement(dayDirectory, { calendar: [calendar[0]!, { text: 'Tomorrow brings the tax call.', targets: ['2026-11-19'] }], mail });
      const second = await narrate(dayDirectory, voiceStudio.url);
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

test('the document narration voices the news digest\'s sentence unless the judgement narrates news', async () => {
  const voiceStudio = await fakeVoiceStudio();
  try {
    await withDayDirectory(async (dayDirectory) => {
      const mail = [{ text: 'Two mails wait.', targets: ['personal'] }];
      await mkdir(join(dayDirectory, 'sources'));
      await writeFile(join(dayDirectory, 'sources', 'news-digest.json'), JSON.stringify({
        status: 'ok', lead: null, releases: [], narration: { text: 'Model Nine leads the news.', links: [] },
      }));
      await writeJudgement(dayDirectory, { mail });
      assert.equal((await narrate(dayDirectory, voiceStudio.url)).exitCode, 0);
      assert.deepEqual(voiceStudio.spokenTexts, ['Two mails wait.', 'Model Nine leads the news.']);

      await writeJudgement(dayDirectory, { mail, news: [{ text: 'Nothing new in AI.', targets: [] }] });
      assert.equal((await narrate(dayDirectory, voiceStudio.url)).exitCode, 0);
      assert.deepEqual(Object.keys(await readClips(dayDirectory)), ['Two mails wait.', 'Nothing new in AI.']);
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
      assert.equal((await narrate(dayDirectory, voiceStudio.url)).exitCode, 0);

      await writeJudgement(dayDirectory, { mail: [kept, { text: 'A new sentence.', targets: [] }] });
      const run = await narrate(dayDirectory, await deadBackendUrl());
      assert.equal(run.exitCode, 2);
      assert.match(run.stderr, /VoiceStudio is not reachable at .* and could not be started/);
      assert.match(run.stdout, /voiced 1 of 2 narration sentences, 0 rendered/);
      assert.deepEqual(Object.keys(await readClips(dayDirectory)), [kept.text]);
      const log = await readFile(join(dayDirectory, 'narrate.log'), 'utf8');
      assert.match(log, /^voiced 1 of 2 narration sentences, 0 rendered.*\nVoiceStudio is not reachable/, 'the result line stays in the day folder');
    });
  } finally {
    await voiceStudio.close();
  }
});
