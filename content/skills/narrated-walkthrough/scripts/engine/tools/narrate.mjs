import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { speak } from './gemini-tts.mjs';
import { clipOf, hashOf, sentencesPerTake, ttsModel } from './clips.mjs';

/*
 * Free-tier Gemini TTS allows few requests per day, so missing sentences are synthesised several per
 * take and split into one clip per beat at the pauses, so every highlight change lands where its
 * sentence starts. Writes timeline.json with each clip's speech length.
 */
const script = JSON.parse(readFileSync('script.json', 'utf8'));
const model = ttsModel;
mkdirSync('audio/clips', { recursive: true });
mkdirSync('audio/takes', { recursive: true });

const run = (command, argumentsList) => {
	const result = spawnSync(command, argumentsList, { encoding: 'utf8', timeout: 120000 });
	if (result.status !== 0) {
		throw new Error(`${command} failed: ${result.stderr?.slice(-800) ?? result.error}`);
	}
	return result;
};
const ffmpeg = (...argumentsList) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argumentsList]);
const durationOf = (path) =>
	Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).stdout.trim());
const silencesOf = (path) => {
	const output = spawnSync('ffmpeg', ['-hide_banner', '-i', path, '-af', 'silencedetect=noise=-45dB:d=0.2', '-f', 'null', '-'], {
		encoding: 'utf8',
		timeout: 60000,
	}).stderr;
	return [...output.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
};
/*
 * Picks the pauses between beats: long pauses are rewarded, and each beat's length must match its
 * share of the text, because a comma pause inside a sentence can outlast the pause between beats.
 */
const chooseSplits = (silences, duration, characterCounts) => {
	const secondsPerCharacter = duration / characterCounts.reduce((sum, count) => sum + count, 0);
	let best = { cost: Infinity, splits: [] };
	const search = (startIndex, chosen) => {
		if (chosen.length === characterCounts.length - 1) {
			const boundaries = [0, ...chosen.flat(), duration];
			let cost = 0;
			characterCounts.forEach((count, index) => {
				const actual = boundaries[2 * index + 1] - boundaries[2 * index];
				cost += 4 * Math.log(actual / (count * secondsPerCharacter)) ** 2;
			});
			cost -= chosen.reduce((sum, [start, end]) => sum + (end - start), 0);
			if (cost < best.cost) best = { cost, splits: [...chosen] };
			return;
		}
		for (let index = startIndex; index < silences.length; index++) {
			search(index + 1, [...chosen, silences[index]]);
		}
	};
	search(0, []);
	return best.splits;
};
/* Soft onsets sit below the pause threshold, so each cut opens a little early and keeps a short silence. */
const onsetMargin = 0.12;
const trimSilence = (keep) => `silenceremove=start_periods=1:start_threshold=-50dB:start_silence=${keep}`;

const beats = script.scenes.flatMap((scene) => scene.beats.map((beat) => ({ ...beat, clip: clipOf(script, beat.say) })));

const splitTake = (take, sentences) => {
	const duration = durationOf(take);
	const inner = silencesOf(take).filter(([start, end]) => start > 0.05 && end < duration - 0.05);
	const splits = chooseSplits(inner, duration, sentences.map((say) => say.length));
	if (splits.length !== sentences.length - 1) {
		throw new Error(`${take}: found ${inner.length} pauses for ${sentences.length} sentences`);
	}
	sentences.forEach((say, index) => {
		const from = index === 0 ? 0 : Math.max(splits[index - 1][0], splits[index - 1][1] - onsetMargin);
		const to = index === splits.length ? duration : Math.min(splits[index][1], splits[index][0] + onsetMargin);
		/* atrim runs first: silenceremove ahead of an output -ss would shift the timeline and clip the next words. */
		const filter = `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS,${trimSilence(0.05)},areverse,${trimSilence(0.1)},areverse,afade=t=in:d=0.01`;
		ffmpeg('-i', take, '-af', filter, '-ar', '48000', '-ac', '1', clipOf(script, say));
	});
};

/* Clips are keyed by sentence and each take keeps its sentence list, so an edited script only synthesises new sentences. */
const missing = new Set(beats.filter((beat) => !existsSync(beat.clip)).map((beat) => beat.say));
for (const manifest of readdirSync('audio/takes').filter((name) => name.endsWith('.json'))) {
	const sentences = JSON.parse(readFileSync(`audio/takes/${manifest}`, 'utf8'));
	if (!sentences.some((say) => missing.has(say))) continue;
	splitTake(`audio/takes/${manifest.replace(/\.json$/, '.wav')}`, sentences);
	sentences.forEach((say) => missing.delete(say));
}
const unsynthesised = [...missing];
console.log(`${unsynthesised.length} new sentences, ${Math.ceil(unsynthesised.length / sentencesPerTake)} TTS requests`);
let requests = 0;
for (let offset = 0; offset < unsynthesised.length; offset += sentencesPerTake) {
	const sentences = unsynthesised.slice(offset, offset + sentencesPerTake);
	const take = `audio/takes/${hashOf(script, sentences.join(' <long pause> '))}.wav`;
	console.log(`synthesising ${sentences.length} sentences`);
	requests++;
	await speak({ text: sentences.join(' <long pause> '), style: script.style, voice: script.voice, model, outputPath: take });
	writeFileSync(take.replace(/\.wav$/, '.json'), JSON.stringify(sentences, null, '\t'));
	splitTake(take, sentences);
}

/* Speech rates far from the others usually mean a misread identifier or a split at the wrong pause. */
const timings = beats.map((beat) => {
	const speech = Number(durationOf(beat.clip).toFixed(3));
	const wordsPerSecond = (beat.say.split(/\s+/).length / speech).toFixed(2);
	console.log(`${speech.toFixed(2).padStart(6)}s ${wordsPerSecond} w/s  ${beat.say.slice(0, 70)}`);
	return { clip: beat.clip, speech };
});
writeFileSync('timeline.json', JSON.stringify({ model, beats: timings }, null, '\t'));
console.log(`${beats.length} beats, ${requests} TTS requests`);
