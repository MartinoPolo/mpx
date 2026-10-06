import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHighlighter } from 'shiki';
import { openRevision } from './definitions.mjs';
import { clipOf } from './clips.mjs';

/*
 * Builds the page from the run folder's script.json and timeline.json: the player, review.js (files at
 * both revisions, Shiki tokens, chapters) and one audio clip per beat. The output folder is rewritten
 * whole, so it holds exactly what the page loads. Usage: node <engine>/tools/build.mjs [outputDirectory]
 */
const outputDirectory = process.argv[2] ?? 'page';
const engineFile = (relativePath) => fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
const script = JSON.parse(readFileSync('script.json', 'utf8'));
const timeline = JSON.parse(readFileSync('timeline.json', 'utf8'));
const { repository, base, head } = script.review;
const vsCodeTheme = JSON.parse(readFileSync(engineFile('theme.json'), 'utf8'));
const languageByExtension = { '.svelte': 'svelte', '.ts': 'ts', '.js': 'js', '.css': 'css', '.json': 'json' };
const highlighter = await createHighlighter({ themes: [vsCodeTheme], langs: [...new Set(Object.values(languageByExtension))] });
/* Code needs a moment to read after each beat. */
const defaultBeatPause = 1.5;

const run = (command, argumentsList) => {
	const result = spawnSync(command, argumentsList, { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`${command} ${argumentsList.join(' ')}: ${result.stderr?.slice(-800) ?? result.error}`);
	return result.stdout;
};
const git = (...argumentsList) => run('git', ['-C', repository, ...argumentsList]);
const readAt = (revision, filePath) => git('show', `${revision}:${filePath}`).replaceAll('\r\n', '\n').replace(/\n$/, '');

/* Tokens are flat [startColumn, styleIndex, ...] pairs per line; the palette maps a style index to a color and font style. */
const palette = [];
const styleIndexes = new Map();
const styleIndexOf = (color, fontStyle) => {
	const key = `${color.slice(0, 7).toLowerCase()}|${fontStyle & 3}`;
	if (!styleIndexes.has(key)) {
		styleIndexes.set(key, palette.length);
		palette.push({ color: color.slice(0, 7).toLowerCase(), italic: Boolean(fontStyle & 1), bold: Boolean(fontStyle & 2) });
	}
	return styleIndexes.get(key);
};
const defaultColor = vsCodeTheme.colors['editor.foreground'] ?? '#bbbebf';
const tokenize = (code, language) =>
	highlighter.codeToTokens(code, { lang: language, theme: vsCodeTheme.name }).tokens.map((lineTokens) => {
		let column = 0;
		return lineTokens.flatMap(({ content, color, fontStyle = 0 }) => {
			const pair = [column, styleIndexOf(color ?? defaultColor, fontStyle)];
			column += content.length;
			return pair;
		});
	});

const CONTEXT = 0;
const ADDED = 1;
const REMOVED = 2;
/* Rows are [kind, oldNumber, newNumber] for the whole file, so the unified view can scroll from top to bottom. */
const unifiedRows = (filePath, previous, current) => {
	if (previous === null) return current.split('\n').map((_, index) => [ADDED, 0, index + 1]);
	if (current === null) return previous.split('\n').map((_, index) => [REMOVED, index + 1, 0]);
	const rows = [];
	let oldNumber = 0;
	let newNumber = 0;
	let inHunk = false;
	for (const line of git('diff', '--no-color', '-U1000000', base, head, '--', filePath).split('\n')) {
		if (line.startsWith('@@')) inHunk = true;
		else if (!inHunk) continue;
		else if (line.startsWith('+')) rows.push([ADDED, 0, ++newNumber]);
		else if (line.startsWith('-')) rows.push([REMOVED, ++oldNumber, 0]);
		else if (line.startsWith(' ')) rows.push([CONTEXT, ++oldNumber, ++newNumber]);
	}
	return rows;
};

const files = {};
for (const line of git('diff', '--name-status', base, head).trim().split('\n')) {
	const [status, ...paths] = line.split('\t');
	const filePath = paths.at(-1);
	const previousPath = paths[0];
	const language = languageByExtension[path.extname(filePath)] ?? 'text';
	const previous = status === 'A' ? null : readAt(base, previousPath);
	const current = status === 'D' ? null : readAt(head, filePath);
	const highlight = (code) => (code === null ? null : language === 'text' ? code.split('\n').map(() => []) : tokenize(code, language));
	const rows = unifiedRows(filePath, previous, current);
	files[filePath] = {
		status: { A: 'added', D: 'deleted' }[status[0]] ?? 'modified',
		previous,
		current,
		previousTokens: highlight(previous),
		currentTokens: highlight(current),
		rows,
		added: rows.filter(([kind]) => kind === ADDED).length,
		removed: rows.filter(([kind]) => kind === REMOVED).length,
		narrated: false,
	};
}

/* Files the narrated code imports are added unchanged, so a definition can be followed into them. */
const narratedPaths = Object.values(script.files).map((file) => file.path);
const revisions = { base: openRevision(repository, base), head: openRevision(repository, head) };
const importedPaths = [...new Set([...revisions.base.importsOf(narratedPaths), ...revisions.head.importsOf(narratedPaths)])].filter((filePath) => !files[filePath]);
for (const filePath of importedPaths) {
	const content = readAt(head, filePath);
	files[filePath] = {
		status: 'unchanged',
		previous: content,
		current: content,
		previousTokens: null,
		currentTokens: tokenize(content, languageByExtension[path.extname(filePath)] ?? 'ts'),
		rows: content.split('\n').map((_, index) => [CONTEXT, index + 1, index + 1]),
		added: 0,
		removed: 0,
		narrated: false,
	};
}
const isNavigable = (filePath) => Boolean(files[filePath]);
const pathsWhere = (predicate) => Object.keys(files).filter((filePath) => predicate(files[filePath]));
const definitions = {
	base: revisions.base.index(pathsWhere((file) => file.status === 'modified' || file.status === 'deleted'), isNavigable),
	head: revisions.head.index(pathsWhere((file) => file.status !== 'deleted'), isNavigable),
};

const pathOf = (fileId) => {
	const filePath = script.files[fileId]?.path;
	if (!files[filePath]) throw new Error(`${fileId}: ${filePath} is not changed between ${base} and ${head}`);
	files[filePath].narrated = true;
	return filePath;
};
const rowTextOf = (file, [kind, oldNumber, newNumber]) =>
	kind === REMOVED ? file.previous.split('\n')[oldNumber - 1] : file.current.split('\n')[newNumber - 1];
const rowIndexOf = (filePath, reference) => {
	const index = files[filePath].rows.findIndex(([kind, oldNumber, newNumber]) =>
		reference.old ? kind !== ADDED && oldNumber === reference.old : kind !== REMOVED && newNumber === reference.line,
	);
	if (index < 0) throw new Error(`${filePath}: no row for ${JSON.stringify(reference)}`);
	return index;
};
const parseRows = (filePath, specification) =>
	specification.split(',').flatMap((part) => {
		const old = part.startsWith('o');
		const [first, last = first] = part.replaceAll('o', '').split('-').map(Number);
		return Array.from({ length: last - first + 1 }, (_, offset) =>
			rowIndexOf(filePath, old ? { old: first + offset } : { line: first + offset }),
		);
	});
/* A highlighted change always brings its whole run of removed and added rows, so old and new code are read together. */
const withChangeRuns = (filePath, indexes) => {
	const { rows, status } = files[filePath];
	const expanded = new Set(indexes);
	const isChange = (index) => rows[index] && rows[index][0] !== CONTEXT;
	if (status === 'modified') {
		for (const index of indexes.filter(isChange)) {
			for (let above = index - 1; isChange(above); above--) expanded.add(above);
			for (let below = index + 1; isChange(below); below++) expanded.add(below);
		}
	}
	return [...expanded].sort((first, second) => first - second);
};
const resolveStep = (step, fallback) => {
	const filePath = step.file ? pathOf(step.file) : fallback.file;
	const row = rowIndexOf(filePath, step.token);
	const start = rowTextOf(files[filePath], files[filePath].rows[row]).indexOf(step.token.text);
	if (start < 0) throw new Error(`${filePath}: token "${step.token.text}" not in row ${row}`);
	return {
		file: filePath,
		rows: withChangeRuns(filePath, [...parseRows(filePath, step.lines), row]),
		token: { row, start, length: step.token.text.length },
		symbol: step.symbol ?? fallback.symbol,
		link: Boolean(step.link),
		at: step.at ?? 0,
	};
};

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(path.join(outputDirectory, 'audio'), { recursive: true });
mkdirSync('audio/encoded', { recursive: true });
/* Clips are encoded once into the run's audio folder, so a rebuild only copies them. */
const clipFor = (beatTiming) => {
	const name = `${path.basename(beatTiming.clip, '.wav')}.mp3`;
	const encoded = path.join('audio/encoded', name);
	if (!existsSync(encoded)) {
		run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', beatTiming.clip, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-b:a', '96k', encoded]);
	}
	copyFileSync(encoded, path.join(outputDirectory, 'audio', name));
	return `audio/${name}`;
};

/* The demo is recorded by tools/demo-record.mjs; beats name the recorded clip they play. */
const demoRecording = script.scenes.some((scene) => scene.demo) ? JSON.parse(readFileSync('cache/demo/demo.json', 'utf8')) : null;
if (demoRecording) {
	mkdirSync(path.join(outputDirectory, 'demo'), { recursive: true });
	copyFileSync(path.join('cache/demo', demoRecording.video), path.join(outputDirectory, 'demo', demoRecording.video));
}
const clipRange = (id) => {
	if (!demoRecording.clips[id]) throw new Error(`demo has no clip "${id}"`);
	return demoRecording.clips[id];
};
/* Cues name a phrase of the narration; its time is estimated from where it sits in the sentence. */
const phraseAt = (beat, timing, phrase) => {
	if (phrase === undefined) return 0;
	const index = beat.say.indexOf(phrase);
	if (index < 0) throw new Error(`"${phrase}" is not in: ${beat.say}`);
	return Number(((timing.speech * index) / beat.say.length).toFixed(2));
};
/* Highlight targets are script file ids, card group, point or option labels, recorded demo regions, or the live box. */
const targetOf = (scene, name) => {
	if (script.files[name]) return `file:${script.files[name].path}`;
	if (scene.groups?.some((group) => group.label === name)) return `group:${name}`;
	if (scene.points?.some((point) => point.label === name)) return `point:${name}`;
	if (scene.options?.some((option) => option.label === name)) return `option:${name}`;
	if (scene.demo && demoRecording.regions[name]) return `region:${name}`;
	if (scene.demo && script.demo.live && name === 'live') return 'live';
	throw new Error(`unknown highlight target "${name}" in "${scene.title}"`);
};

/* Card groups list paths; "rest" collects the changed files no other group of that card names. */
const groupsOf = (scene) => {
	const changed = pathsWhere((file) => file.status !== 'unchanged').sort();
	const groups = (scene.groups ?? [{ label: 'Walked through', narrated: true }, { label: 'Also changed, not narrated', rest: true }]).map((group) => ({
		label: group.label,
		files: group.files?.map((fileId) => script.files[fileId].path) ?? (group.narrated ? changed.filter((filePath) => files[filePath].narrated) : []),
		rest: Boolean(group.rest),
	}));
	const named = new Set(groups.flatMap((group) => group.files));
	for (const group of groups.filter((item) => item.rest)) group.files = changed.filter((filePath) => !named.has(filePath));
	return groups.filter((group) => group.files.length).map(({ label, files: groupFiles }) => ({ label, files: groupFiles }));
};

/* An alternative's sketch is a few lines of code, highlighted like the files so it reads as the same codebase. */
const optionsOf = (scene) =>
	scene.options?.map(({ sketch, ...option }) => ({
		...option,
		sketch: sketch && { lines: sketch.code.split('\n'), tokens: tokenize(sketch.code, sketch.language) },
	})) ?? null;

/* Clips are found by sentence rather than position, so a script with scenes removed or reordered still builds. */
const timingByClip = new Map(timeline.beats.map((timing) => [timing.clip, timing]));
const timingOf = (beat) => {
	const timing = timingByClip.get(clipOf(script, beat.say));
	if (!timing) throw new Error(`not narrated yet, run tools/narrate.mjs: ${beat.say}`);
	return timing;
};

let beatCount = 0;
const chapters = script.scenes.map(({ beats, ...scene }) => {
	const panes = (scene.panes ?? []).map(pathOf);
	/* An overview or a demo is understood at a glance, so its beats run on; code keeps a pause to read. */
	const visual = Boolean(scene.demo || scene.card === 'overview');
	let heldFrame = null;
	return {
		card: scene.card ?? null,
		title: scene.title,
		visual,
		panes,
		points: scene.points ?? null,
		options: optionsOf(scene),
		demo: scene.demo ? { video: `demo/${demoRecording.video}`, regions: demoRecording.regions, live: script.demo.live } : null,
		beats: beats.map((beat) => {
			beatCount++;
			const timing = timingOf(beat);
			const steps = [];
			if (beat.token) {
				const main = resolveStep(beat, { file: beat.file ? pathOf(beat.file) : panes[0] });
				steps.push(main);
				if (beat.then) steps.push(resolveStep(beat.then, main));
			}
			/* A demo beat without a clip of its own keeps showing where the previous clip ended. */
			const video = beat.video ? { ...clipRange(beat.video.clip), at: phraseAt(beat, timing, beat.video.at) } : heldFrame;
			if (video) heldFrame = { from: video.to, to: video.to, at: 0 };
			const highlights = (beat.highlights ?? []).map((cue) => ({ at: phraseAt(beat, timing, cue.at), targets: cue.targets.map((name) => targetOf(scene, name)) }));
			return { note: beat.note, say: beat.say, clip: clipFor(timing), duration: timing.speech, pause: beat.pause ?? (visual ? 0 : defaultBeatPause), video, highlights, steps };
		}),
	};
});
/* Groups are resolved last, once pathOf has marked every narrated file. */
script.scenes.forEach((scene, index) => {
	if (scene.card === 'changes') chapters[index].groups = groupsOf(scene);
});

/* The page chrome takes its colors from the same VS Code theme as the code, so it reads like the editor. */
const themeColor = (key, fallback) => vsCodeTheme.colors[key] ?? fallback;
const chrome = {
	'--stage': themeColor('sideBar.background', '#191a1b'),
	'--editor': themeColor('editor.background', '#121314'),
	'--editor-foreground': themeColor('editor.foreground', '#bbbebf'),
	'--border': themeColor('panel.border', '#2a2b2c'),
	'--text-primary': '#e8e8e8',
	'--text-secondary': themeColor('foreground', '#bfbfbf'),
	'--text-muted': themeColor('descriptionForeground', '#8c8c8c'),
	'--line-number': themeColor('editorLineNumber.foreground', '#858889'),
	'--line-number-active': themeColor('editorLineNumber.activeForeground', '#bbbebf'),
	'--accent': themeColor('textLink.foreground', '#48a0c7'),
	'--selection': themeColor('list.activeSelectionBackground', '#ffffff22'),
	'--selection-inactive': themeColor('list.inactiveSelectionBackground', '#2c2d2e'),
	'--added': themeColor('gitDecoration.addedResourceForeground', '#73c991'),
	'--modified': themeColor('gitDecoration.modifiedResourceForeground', '#e5ba7d'),
	'--removed': themeColor('editorGutter.deletedBackground', '#f28772'),
};
const themeColors = Object.fromEntries(Object.entries(vsCodeTheme.colors).filter(([, value]) => /^#[0-9a-f]{3,8}$/i.test(value)));
const review = {
	title: script.title,
	subtitle: script.subtitle,
	revisions: { base, head },
	theme: { colors: themeColors, chrome, palette },
	files,
	definitions,
	chapters,
};
writeFileSync(path.join(outputDirectory, 'review.js'), `window.REVIEW = ${JSON.stringify(review)};\n`);
const player = engineFile('player/dist');
for (const name of readdirSync(player)) copyFileSync(path.join(player, name), path.join(outputDirectory, name));
const escapeHtml = (text) => text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
const page = readFileSync(path.join(player, 'index.html'), 'utf8');
writeFileSync(path.join(outputDirectory, 'index.html'), page.replace(/<title>.*<\/title>/, `<title>${escapeHtml(script.title)}</title>`));
console.log(`${outputDirectory}: ${Object.keys(files).length} files, ${chapters.length} chapters, ${beatCount} beats`);
