import * as monaco from 'monaco-editor/editor/editor.main.js';
import workerSource from 'editor-worker-source';
import './player.css';
import { registerDefinitions } from './definitions.js';

const review = window.REVIEW;
const CONTEXT = 0;
const ADDED = 1;
const REMOVED = 2;
const KIND_NAMES = ['context', 'added', 'removed'];
const SPEEDS = {
	superSlow: { label: 'Super slow', rate: 0.8, pause: 1.6 },
	slow: { label: 'Slow', rate: 0.9, pause: 1.1 },
	medium: { label: 'Medium', rate: 1, pause: 0.7 },
	fast: { label: 'Fast', rate: 1.15, pause: 0.42 },
	superFast: { label: 'Super fast', rate: 1.3, pause: 0.25 },
};
const CHAPTER_PAUSE = 2.5;
const VISUAL_CHAPTER_PAUSE = 0.8;
/* A demo clip ends with its result on screen; the beat holds it a moment before moving on. */
const VIDEO_SETTLE = 0.8;
const CAMERA_DURATION = 700;
const LEAVING_DURATION = 650;

const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
self.MonacoEnvironment = { getWorker: () => new Worker(workerUrl) };

for (const [name, value] of Object.entries(review.theme.chrome)) document.documentElement.style.setProperty(name, value);
monaco.editor.defineTheme('review', {
	base: 'vs-dark',
	inherit: true,
	rules: [
		{ token: '', foreground: (review.theme.colors['editor.foreground'] ?? '#bbbebf').slice(1, 7) },
		...review.theme.palette.map((style, index) => ({
			token: `s${index}`,
			foreground: style.color.slice(1),
			fontStyle: [style.italic && 'italic', style.bold && 'bold'].filter(Boolean).join(' '),
		})),
	],
	colors: review.theme.colors,
});

const element = (tag, className, parent, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	parent?.append(node);
	return node;
};
const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/* Tokens come precomputed from Shiki, one line per tokenizer state, so Monaco paints exactly what VS Code would. */
class LineState {
	constructor(line) {
		this.line = line;
	}
	clone() {
		return new LineState(this.line);
	}
	equals(other) {
		return other.line === this.line;
	}
}
let languageCount = 0;
const modelDescriptions = new Map();
const createModel = (filePath, view, lines, tokenLines) => {
	const language = `review-${languageCount++}`;
	monaco.languages.register({ id: language });
	monaco.languages.setTokensProvider(language, {
		getInitialState: () => new LineState(0),
		tokenize: (_text, state) => {
			const pairs = tokenLines[state.line] ?? [];
			const tokens = [];
			for (let index = 0; index < pairs.length; index += 2) tokens.push({ startIndex: pairs[index], scopes: `s${pairs[index + 1]}` });
			return { tokens, endState: new LineState(state.line + 1) };
		},
	});
	const model = monaco.editor.createModel(lines.join('\n'), language, monaco.Uri.from({ scheme: 'review', path: `/${filePath}`, query: view }));
	modelDescriptions.set(model.uri.toString(), { filePath, view });
	return model;
};
const describeModel = (model) => modelDescriptions.get(model.uri.toString()) ?? null;
const models = new Map();
const modelsOf = (filePath) => {
	if (!models.has(filePath)) {
		const file = review.files[filePath];
		const previousLines = file.previous?.split('\n') ?? [];
		const currentLines = file.current?.split('\n') ?? [];
		const textOf = ([kind, oldNumber, newNumber]) => (kind === REMOVED ? previousLines[oldNumber - 1] : currentLines[newNumber - 1]);
		const tokensOf = ([kind, oldNumber, newNumber]) =>
			kind === REMOVED ? file.previousTokens[oldNumber - 1] : file.currentTokens[newNumber - 1];
		const unified = createModel(filePath, 'unified', file.rows.map(textOf), file.rows.map(tokensOf));
		/* Ownerless model decorations show in every editor of the model, peek views included. */
		unified.deltaDecorations(
			[],
			file.rows.flatMap(([kind], index) =>
				kind === CONTEXT
					? []
					: [
							{
								range: new monaco.Range(index + 1, 1, index + 1, 1),
								options: {
									isWholeLine: true,
									className: `row-${KIND_NAMES[kind]}`,
									lineNumberClassName: `number-${KIND_NAMES[kind]}`,
									linesDecorationsClassName: `gutter-${KIND_NAMES[kind]}`,
									minimap: { color: diffColors[kind], position: monaco.editor.MinimapPosition.Inline },
									overviewRuler: { color: diffColors[kind], position: monaco.editor.OverviewRulerLane.Full },
								},
							},
						],
			),
		);
		models.set(filePath, {
			unified,
			original: file.status === 'modified' ? createModel(filePath, 'original', previousLines, file.previousTokens) : null,
			modified: file.status === 'modified' ? createModel(filePath, 'modified', currentLines, file.currentTokens) : null,
		});
	}
	return models.get(filePath);
};

const editorOptions = {
	theme: 'review',
	readOnly: true,
	domReadOnly: true,
	automaticLayout: true,
	fontFamily: "'JetBrains Mono', monospace",
	fontSize: 14,
	lineHeight: 22,
	fontLigatures: false,
	minimap: { enabled: true, renderCharacters: false, showSlider: 'always' },
	scrollBeyondLastLine: false,
	renderLineHighlight: 'none',
	occurrencesHighlight: 'off',
	selectionHighlight: false,
	guides: { indentation: false, bracketPairs: false },
	bracketPairColorization: { enabled: false },
	matchBrackets: 'never',
	folding: false,
	stickyScroll: { enabled: false },
	links: false,
	hover: { enabled: true, delay: 350, sticky: true },
	unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
	lineDecorationsWidth: 14,
	lineNumbersMinChars: 4,
	padding: { top: 10, bottom: 10 },
	scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
	overviewRulerBorder: false,
	cursorBlinking: 'solid',
};
/* Hex only: Monaco parses minimap decoration colors with Color.fromHex, which paints anything else red. */
const diffColors = { [ADDED]: '#73c991b3', [REMOVED]: '#f28772b3' };

/*
 * A unified model numbers each row by the revision it shows. Line numbers are an editor option that peek
 * views inherit from their parent, so every editor sets them from its own model whenever the model changes.
 */
const numberLines = (editor) => {
	const description = editor.getModel() && describeModel(editor.getModel());
	const rows = description?.view === 'unified' ? review.files[description.filePath].rows : null;
	editor.updateOptions({ lineNumbers: rows ? (line) => (rows[line - 1] ? String(rows[line - 1][0] === REMOVED ? rows[line - 1][1] : rows[line - 1][2]) : '') : 'on' });
};
monaco.editor.onDidCreateEditor((editor) => {
	editor.onDidChangeModel(() => numberLines(editor));
	queueMicrotask(() => numberLines(editor));
});

const cameraFrames = new WeakMap();
const stopCamera = (editor) => cancelAnimationFrame(cameraFrames.get(editor));
const scrollEditor = (editor, target, animate) => {
	const limit = editor.getScrollHeight() - editor.getLayoutInfo().height;
	const destination = Math.max(0, Math.min(target, limit));
	stopCamera(editor);
	if (!animate) {
		editor.setScrollTop(destination);
		return;
	}
	const origin = editor.getScrollTop();
	const started = performance.now();
	const frame = (now) => {
		const progress = Math.min(1, (now - started) / CAMERA_DURATION);
		editor.setScrollTop(origin + (destination - origin) * (1 - (1 - progress) ** 3));
		if (progress < 1) cameraFrames.set(editor, requestAnimationFrame(frame));
	};
	cameraFrames.set(editor, requestAnimationFrame(frame));
};

/* One file in one or two columns. Narrated focus is expressed per unified row and mapped onto whichever editors show it. */
class Pane {
	constructor(parent, filePath, columns, onInteraction) {
		this.filePath = filePath;
		this.file = review.files[filePath];
		this.element = element('section', 'pane', parent);
		const header = element('div', 'pane-header', this.element);
		const slash = filePath.lastIndexOf('/');
		element('span', '', header, filePath.slice(0, slash + 1));
		element('span', 'pane-file', header, filePath.slice(slash + 1));
		element('span', `badge ${this.file.status}`, header, { added: 'new file', unchanged: 'referenced' }[this.file.status] ?? this.file.status);
		const stats = element('span', 'stats', header);
		if (this.file.added) element('span', 'stat-added', stats, `+${this.file.added}`);
		if (this.file.removed) element('span', 'stat-removed', stats, `−${this.file.removed}`);
		const host = element('div', 'editor', element('div', 'pane-body', this.element));
		const fileModels = modelsOf(filePath);
		this.split = columns === 2 && this.file.status === 'modified';
		if (this.split) {
			this.diffEditor = monaco.editor.createDiffEditor(host, {
				...editorOptions,
				renderSideBySide: true,
				useInlineViewWhenSpaceIsLimited: false,
				originalEditable: false,
				renderMarginRevertIcon: false,
				renderOverviewRuler: true,
			});
			this.diffEditor.setModel({ original: fileModels.original, modified: fileModels.modified });
			this.editors = { original: this.diffEditor.getOriginalEditor(), modified: this.diffEditor.getModifiedEditor() };
			this.ready = new Promise((resolve) => {
				const subscription = this.diffEditor.onDidUpdateDiff(() => {
					subscription.dispose();
					resolve();
				});
				setTimeout(resolve, 2000);
			});
		} else {
			const editor = monaco.editor.create(host, { ...editorOptions, model: fileModels.unified });
			this.editors = { unified: editor };
			this.ready = Promise.resolve();
		}
		this.collections = new Map(Object.values(this.editors).map((editor) => [editor, editor.createDecorationsCollection()]));
		this.focusState = { step: null, markStyle: null };
		this.litBefore = new Map();
		for (const type of ['wheel', 'mousedown', 'keydown', 'touchstart']) {
			this.element.addEventListener(type, onInteraction, { capture: true, passive: true });
		}
	}

	locate(rowIndex) {
		const [kind, oldNumber, newNumber] = this.file.rows[rowIndex];
		if (!this.split) return [{ editor: this.editors.unified, line: rowIndex + 1 }];
		const locations = [];
		if (kind !== ADDED) locations.push({ editor: this.editors.original, line: oldNumber });
		if (kind !== REMOVED) locations.push({ editor: this.editors.modified, line: newNumber });
		return locations;
	}

	locateToken(token) {
		return this.locate(token.row).at(-1);
	}

	render(withLeaving) {
		const decorations = new Map([...this.collections.keys()].map((editor) => [editor, []]));
		const litNow = new Map();
		const { step, markStyle } = this.focusState;
		for (const rowIndex of step?.rows ?? []) {
			for (const { editor, line } of this.locate(rowIndex)) {
				if (!litNow.has(editor)) litNow.set(editor, new Map());
				litNow.get(editor).set(line, this.file.rows[rowIndex][0]);
			}
		}
		const lineDecorations = (editor, line, kind, leaving) => [
			{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: `band band-${KIND_NAMES[kind]}${leaving ? ' band-leaving' : ''}` } },
			{ range: new monaco.Range(line, 1, line, editor.getModel().getLineMaxColumn(line)), options: { inlineClassName: leaving ? 'unlit' : 'lit' } },
		];
		for (const [editor, lines] of litNow) {
			for (const [line, kind] of lines) decorations.get(editor).push(...lineDecorations(editor, line, kind, false));
		}
		if (withLeaving) {
			for (const [editor, lines] of this.litBefore) {
				for (const [line, kind] of lines) {
					if (!litNow.get(editor)?.has(line) && decorations.has(editor)) decorations.get(editor).push(...lineDecorations(editor, line, kind, true));
				}
			}
		}
		if (step && markStyle) {
			const { editor, line } = this.locateToken(step.token);
			const gap = { content: ' ', inlineClassName: 'mark-gap', inlineClassNameAffectsLetterSpacing: true, cursorStops: monaco.editor.InjectedTextCursorStops.None };
			decorations.get(editor).push({
				range: new monaco.Range(line, step.token.start + 1, line, step.token.start + step.token.length + 1),
				options: { className: `mark ${markStyle}`, before: gap, after: gap },
			});
		}
		for (const [editor, list] of decorations) this.collections.get(editor).set(list);
		return litNow;
	}

	focus(step, markStyle) {
		if (this.focusState.step === step && this.focusState.markStyle === markStyle) return;
		this.focusState = { step, markStyle };
		const litNow = this.render(true);
		clearTimeout(this.leavingTimer);
		this.leavingTimer = setTimeout(() => this.render(false), LEAVING_DURATION);
		this.litBefore = litNow;
	}

	/* Moves only when the block or its token is off screen: a block that fits is centred, a taller one is centred on the token. */
	reveal(step, animate) {
		const tokenLocation = this.locateToken(step.token);
		const editor = tokenLocation.editor;
		const lines = step.rows.flatMap((rowIndex) => this.locate(rowIndex)).filter((location) => location.editor === editor).map((location) => location.line);
		const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
		const height = editor.getLayoutInfo().height;
		const scrollTop = editor.getScrollTop();
		const firstTop = editor.getTopForLineNumber(Math.min(...lines));
		const blockTop = firstTop - 2 * lineHeight;
		const blockBottom = editor.getTopForLineNumber(Math.max(...lines)) + 3 * lineHeight;
		const tokenTop = editor.getTopForLineNumber(tokenLocation.line);
		const visible = (from, to) => from >= scrollTop && to <= scrollTop + height;
		if (visible(blockTop, blockBottom) && visible(tokenTop - lineHeight, tokenTop + 2 * lineHeight)) return;
		const fits = blockBottom - blockTop <= height;
		const centred = (blockTop + blockBottom - height) / 2;
		const target = fits ? Math.min(firstTop - 2 * lineHeight, Math.max(firstTop - 5 * lineHeight, centred)) : tokenTop - height / 2;
		scrollEditor(editor, target, animate);
	}

	revealFirstChange() {
		const index = this.file.rows.findIndex(([kind]) => kind !== CONTEXT);
		if (index < 0) return;
		const { editor, line } = this.locate(index)[0];
		this.ready.then(() => scrollEditor(editor, editor.getTopForLineNumber(line) - 4 * editor.getOption(monaco.editor.EditorOption.lineHeight), false));
	}

	lineMiddle(editor, line) {
		const editorRectangle = editor.getDomNode().getBoundingClientRect();
		const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
		const y = editorRectangle.top + editor.getTopForLineNumber(line) - editor.getScrollTop() + lineHeight / 2;
		return Math.max(editorRectangle.top + 4, Math.min(y, editorRectangle.bottom - 4));
	}

	stopCamera() {
		Object.values(this.editors).forEach(stopCamera);
	}

	dispose() {
		clearTimeout(this.leavingTimer);
		this.stopCamera();
		(this.diffEditor ?? this.editors.unified).dispose();
		this.element.remove();
	}
}

/* Layout */
const app = document.getElementById('app');
const sidebar = element('aside', 'sidebar', app);
const titleBlock = element('div', 'review-title', sidebar);
element('h1', '', titleBlock, review.title);
element('p', '', titleBlock, review.subtitle);
const chapterSection = element('nav', '', sidebar);
element('div', 'section-heading', chapterSection, 'Chapters');
const chapterList = element('div', '', chapterSection);
const fileSection = element('nav', '', sidebar);
element('div', 'section-heading', fileSection, 'Changed files');
const tree = element('div', '', fileSection);

const main = element('main', 'main', app);
const header = element('header', 'header', main);
const headerText = element('div', '', header);
const kicker = element('div', 'kicker', headerText);
const heading = element('h2', '', headerText);
element('div', 'spacer', header);
const freePill = element('div', 'free-pill', header);
const historyButton = element('button', 'step-button', freePill, '◀ Back');
element('span', '', freePill, 'Free scroll · narration paused');
const backButton = element('button', 'back-button', freePill, 'Back to narration');
const stage = element('div', 'stage', main);

const controls = element('footer', 'controls', app);
const chapterPlay = element('button', 'play-button', controls);
const chapterBar = element('div', 'bar', controls);
const chapterTime = element('span', 'time', controls);
const allPlay = element('button', 'play-button', controls);
const overallBar = element('div', 'bar', controls);
const overallTime = element('span', 'time', controls);
const options = element('div', 'options', controls);
const previousButton = element('button', 'step-button', options, '◀ Previous chapter');
const nextButton = element('button', 'step-button', options, 'Next chapter ▶');
element('div', 'spacer', options);
element('span', 'option-label', options, 'Speed');
const speedControl = element('div', 'segmented', options);
element('span', 'option-label', options, 'Diff');
const columnControl = element('div', 'segmented', options);
const connector = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
connector.id = 'connector';
connector.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle r="4" fill="currentColor"/>';
document.body.append(connector);

/* Player state: chapters hold beats; each beat is its narration clip followed by a pause scaled by the speed setting. */
const state = { chapter: 0, beat: 0, stepIndex: -1, phase: 'speech', pauseStarted: 0, pauseElapsed: 0, playing: false, autoAdvance: false, free: false, chapterFinished: false, speed: 'medium', columns: 1 };
const audio = new Audio();
audio.preload = 'auto';
let panes = [];
let paneKey = '';
let card = null;
let demoVideo = null;
let highlightKey = '';
let link = null;

/* Links may cross chapters: the previous step is the one narrated just before, wherever it was. */
const allSteps = review.chapters.flatMap((chapter) => chapter.beats.flatMap((beat) => beat.steps));
const speed = () => SPEEDS[state.speed];
const currentChapter = () => review.chapters[state.chapter];
const currentBeat = () => currentChapter().beats[state.beat];
const speechLength = (beat) => beat.duration / speed().rate;
const pauseLength = (beat) =>
	Math.max(beat.pause * speed().pause, beat.video ? (beat.video.at + beat.video.to - beat.video.from - beat.duration) / speed().rate + VIDEO_SETTLE : 0);
const beatLength = (beat) => speechLength(beat) + pauseLength(beat);
const chapterLength = (chapter) => chapter.beats.reduce((sum, beat) => sum + beatLength(beat), 0);
const elapsedInBeat = () => (state.phase === 'speech' ? audio.currentTime / speed().rate : speechLength(currentBeat()) + state.pauseElapsed);
const pauseLimit = () => {
	const chapter = currentChapter();
	const chapterEnds = state.beat === chapter.beats.length - 1;
	/* A visual chapter is understood at a glance, so it flows into the next one; the full pause is kept for the move to code. */
	const chapterPause = chapter.visual && review.chapters[state.chapter + 1]?.visual ? VISUAL_CHAPTER_PAUSE : CHAPTER_PAUSE;
	return pauseLength(currentBeat()) + (chapterEnds && state.autoAdvance ? chapterPause * speed().pause : 0);
};

const onInteraction = () => enterFree();
/* A media pane fits its capture into the pane at its own aspect ratio, so region outlines stay on what they mark. */
const createMediaPane = (media) => {
	const pane = element('section', 'pane media-pane');
	pane.dataset.target = `media:${media.id}`;
	const header = element('div', 'pane-header', pane);
	element('span', 'pane-file', header, media.title);
	if (media.link) {
		const anchor = element('a', 'media-link', header, `${media.link.label ?? 'Open'} ↗`);
		Object.assign(anchor, { href: media.link.url, target: '_blank', rel: 'noopener' });
	}
	const body = element('div', 'pane-body media-body', pane);
	const frame = element('div', 'media-frame', body);
	const visual = element(media.kind === 'video' ? 'video' : 'img', 'media-visual', frame);
	visual.src = media.src;
	if (media.kind === 'video') Object.assign(visual, { muted: true, loop: true, autoplay: true, playsInline: true });
	for (const [name, region] of Object.entries(media.regions)) {
		const outline = element('div', 'demo-region', frame);
		outline.dataset.target = `media:${media.id}.${name}`;
		Object.assign(outline.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` });
	}
	new ResizeObserver(() => {
		const scale = Math.min(body.clientWidth / media.width, body.clientHeight / media.height);
		Object.assign(frame.style, { width: `${media.width * scale}px`, height: `${media.height * scale}px` });
	}).observe(body);
	return pane;
};
let mediaPanes = [];
const showPanes = (filePaths, force, media = []) => {
	card?.remove();
	card = null;
	demoVideo = null;
	const key = `${filePaths.join('|')}#${media.map((item) => item.id).join('|')}#${state.columns}`;
	if (!force && key === paneKey) return;
	mediaPanes.forEach((pane) => pane.remove());
	mediaPanes = [];
	/* Panes that stay keep their editor, so a jump to another file leaves the source where the viewer had it. */
	const kept = force ? [] : panes.filter((pane) => filePaths.includes(pane.filePath));
	panes.filter((pane) => !kept.includes(pane)).forEach((pane) => pane.dispose());
	panes = filePaths.map((filePath) => kept.find((pane) => pane.filePath === filePath) ?? new Pane(stage, filePath, state.columns, onInteraction));
	panes.forEach((pane) => stage.append(pane.element));
	mediaPanes = media.map(createMediaPane);
	stage.append(...mediaPanes);
	paneKey = key;
	panes.forEach((pane) => pane.element.classList.toggle('narrating', !state.free));
};
const clearStage = () => {
	panes.forEach((pane) => pane.dispose());
	panes = [];
	mediaPanes.forEach((pane) => pane.remove());
	mediaPanes = [];
	paneKey = '';
	card?.remove();
	demoVideo = null;
	highlightKey = '';
};
/* Cards carry what has no code to show: the overview, the changed files, the alternatives, the review notes and how to try it. */
const showCard = (chapter) => {
	clearStage();
	card = element('div', `card card-${chapter.card}`, stage);
	if (chapter.card === 'overview') {
		element('div', 'card-kicker', card, 'Code walkthrough');
		element('div', 'card-title', card, review.title);
		element('div', 'card-subtitle', card, review.subtitle);
	}
	if (chapter.points) showPoints(chapter.points);
	if (chapter.groups) showGroups(chapter.groups);
	if (chapter.options) showOptions(chapter.options);
	if (chapter.sections) showSections(chapter.sections);
};
/* Steps a reviewer follows to see the change themselves; a section marked collapsed stays closed until opened. */
const showSections = (sections) => {
	const list = element('div', 'card-sections', card);
	for (const section of sections) {
		const details = element('details', 'card-section', list);
		details.dataset.target = `section:${section.label}`;
		details.open = !section.collapsed;
		element('summary', 'section-label', details, section.label);
		if (section.text) element('p', 'section-text', details, section.text);
		const steps = element('ol', 'section-steps', details);
		for (const step of section.steps ?? []) {
			const item = element('li', '', steps);
			if (step.text) element('span', '', item, step.text);
			if (step.command) element('code', 'demo-command', item, step.command);
			if (step.link) {
				const anchor = element('a', 'demo-link', item, step.link.label ?? step.link.url);
				Object.assign(anchor, { href: step.link.url, target: '_blank', rel: 'noopener' });
			}
		}
	}
};
const showPoints = (points) => {
	const list = element('div', 'card-points', card);
	for (const point of points) {
		const row = element('div', 'card-point', list);
		row.dataset.target = `point:${point.label}`;
		element('div', 'point-label', row, point.label);
		element('div', 'point-text', row, point.text);
	}
};
const showSketch = (parent, sketch) => {
	const code = element('pre', 'sketch', parent);
	sketch.lines.forEach((line, lineIndex) => {
		const pairs = sketch.tokens[lineIndex];
		for (let index = 0; index < pairs.length; index += 2) {
			const style = review.theme.palette[pairs[index + 1]];
			const span = element('span', '', code, line.slice(pairs[index], pairs[index + 2] ?? line.length));
			Object.assign(span.style, { color: style.color, fontStyle: style.italic ? 'italic' : '', fontWeight: style.bold ? '700' : '' });
		}
		code.append('\n');
	});
};
const ORIGIN_LABELS = { chosen: 'Chosen', considered: 'Considered', suggestion: 'Suggestion', rejected: 'Rejected' };
const showOptions = (options) => {
	const list = element('div', 'card-options', card);
	for (const option of options) {
		const column = element('section', `option ${option.origin}`, list);
		column.dataset.target = `option:${option.label}`;
		const header = element('div', 'option-header', column);
		element('span', 'option-name', header, option.label);
		element('span', `badge origin-${option.origin}`, header, ORIGIN_LABELS[option.origin]);
		element('p', 'option-summary', column, option.summary);
		if (option.sketch) showSketch(column, option.sketch);
		/* A rejected approach does not solve the problem, so it states why instead of weighing trade-offs. */
		if (option.why) element('p', 'option-why', column, option.why);
		const tradeOffs = element('ul', 'trade-offs', column);
		for (const pro of option.pros ?? []) element('li', 'pro', tradeOffs, pro);
		for (const con of option.cons ?? []) element('li', 'con', tradeOffs, con);
	}
};
const showGroups = (groups) => {
	const list = element('div', 'card-files', card);
	for (const group of groups) {
		element('div', 'group', list, group.label).dataset.target = `group:${group.label}`;
		for (const filePath of group.files) {
			const file = review.files[filePath];
			const row = element('div', 'card-file', list);
			row.dataset.target = `file:${filePath}`;
			row.dataset.group = `group:${group.label}`;
			element('span', `tree-file ${file.status}`, row).append(element('span', 'tree-status', null, file.status[0].toUpperCase()));
			const stats = element('span', 'stats', row);
			if (file.added) element('span', 'stat-added', stats, `+${file.added}`);
			if (file.removed) element('span', 'stat-removed', stats, `−${file.removed}`);
			element('span', '', row, filePath);
		}
	}
};
const showDemo = (chapter) => {
	if (demoVideo && card) return;
	clearStage();
	card = element('div', 'demo', stage);
	const screen = element('div', 'demo-screen', card);
	demoVideo = element('video', 'demo-video', screen);
	demoVideo.src = chapter.demo.video;
	demoVideo.muted = true;
	demoVideo.playsInline = true;
	demoVideo.preload = 'auto';
	for (const [name, region] of Object.entries(chapter.demo.regions)) {
		const outline = element('div', 'demo-region', screen);
		outline.dataset.target = `region:${name}`;
		Object.assign(outline.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` });
	}
	if (!chapter.demo.live) return;
	const live = element('aside', 'demo-live', card);
	live.dataset.target = 'live';
	element('div', 'group', live, 'See it live');
	element('p', '', live, chapter.demo.live.text);
	element('code', 'demo-command', live, chapter.demo.live.command);
	for (const story of chapter.demo.live.stories ?? []) {
		const anchor = element('a', 'demo-link', live, story.label);
		anchor.href = story.url;
		anchor.target = '_blank';
		anchor.rel = 'noopener';
	}
};
/*
 * The video follows the narration clock, so pausing, seeking and speed changes need no bookkeeping of their own.
 * A beat's clip waits on its first frame until the narration reaches the clip's phrase, then runs to its end.
 */
const syncDemo = () => {
	if (!demoVideo) return;
	const range = currentBeat().video;
	if (!range) {
		if (!demoVideo.paused) demoVideo.pause();
		return;
	}
	const elapsed = state.chapterFinished ? Infinity : elapsedInBeat() * speed().rate - range.at;
	const target = Math.min(range.to, range.from + Math.max(0, elapsed));
	const running = state.playing && elapsed > 0 && target < range.to;
	demoVideo.playbackRate = speed().rate;
	if (running && demoVideo.paused) demoVideo.play().catch(() => {});
	if (!running && !demoVideo.paused) demoVideo.pause();
	/* A paused clip sits exactly on its frame, because the video runs a little past the moment it is paused. */
	const drift = Math.abs(demoVideo.currentTime - target);
	if (running ? drift > 0.35 : drift > 0.02 && !demoVideo.seeking) demoVideo.currentTime = target;
};
/* The latest cue the narration has reached marks its targets until the beat ends. */
const showHighlights = () => {
	const cues = currentBeat().highlights;
	const reached = state.chapterFinished ? cues : cues.filter((cue) => cue.at / speed().rate <= elapsedInBeat());
	const targets = reached.at(-1)?.targets ?? [];
	const key = `${state.chapter}:${state.beat}:${targets.join('|')}`;
	if (key === highlightKey) return;
	highlightKey = key;
	stage.classList.toggle('highlighting', targets.length > 0);
	for (const item of stage.querySelectorAll('[data-target]')) {
		item.classList.toggle('highlighted', targets.includes(item.dataset.target) || targets.includes(item.dataset.group));
	}
};
const setScene = (force) => {
	const chapter = currentChapter();
	if (chapter.card) showCard(chapter);
	else if (chapter.demo) showDemo(chapter);
	else showPanes(chapter.panes, force, chapter.media);
};

const showSteps = (animate) => {
	const chapter = currentChapter();
	const history = chapter.beats.flatMap((beat, beatIndex) =>
		beatIndex < state.beat ? beat.steps : beatIndex === state.beat ? beat.steps.slice(0, state.stepIndex + 1) : [],
	);
	const active = history.at(-1) ?? null;
	const previous = active ? (allSteps[allSteps.indexOf(active) - 1] ?? null) : null;
	const linked = active?.link && previous && previous.file !== active.file ? previous : null;
	for (const pane of panes) {
		const [step, markStyle] =
			active && pane.filePath === active.file
				? [active, 'active']
				: linked && pane.filePath === linked.file
					? [linked, 'ghost']
					: [history.findLast((item) => item.file === pane.filePath) ?? null, null];
		pane.focus(step, markStyle);
		if (step) pane.ready.then(() => pane.reveal(step, animate));
	}
	link = linked ? { from: linked, to: active } : null;
	renderTree(active?.file);
};
const applySteps = (force) => {
	const beat = currentBeat();
	const time = state.phase === 'speech' ? audio.currentTime : Infinity;
	const index = beat.steps.findLastIndex((step) => step.at <= time);
	if (index === state.stepIndex && !force) return;
	state.stepIndex = index;
	if (!state.free) showSteps(!force);
};

const goTo = (chapterIndex, beatIndex = 0, offset = 0) => {
	const chapterChanged = chapterIndex !== state.chapter;
	state.chapter = chapterIndex;
	state.beat = beatIndex;
	state.chapterFinished = false;
	setScene(false);
	const beat = currentBeat();
	audio.src = beat.clip;
	audio.defaultPlaybackRate = audio.playbackRate = speed().rate;
	if (offset < speechLength(beat)) {
		state.phase = 'speech';
		audio.currentTime = offset * speed().rate;
	} else {
		state.phase = 'pause';
		state.pauseElapsed = offset - speechLength(beat);
	}
	state.stepIndex = -2;
	applySteps(true);
	if (chapterChanged) panes.forEach((pane) => pane.stopCamera());
	if (state.playing) resume();
	renderChapters();
	renderControls();
};
const resume = () => {
	if (state.phase === 'speech') audio.play().catch(() => {});
	else state.pauseStarted = performance.now() - state.pauseElapsed * 1000;
};
const play = (autoAdvance) => {
	if (state.free) exitFree();
	if (state.chapterFinished) {
		if (autoAdvance && state.chapter < review.chapters.length - 1) goTo(state.chapter + 1);
		else goTo(state.chapter);
	}
	state.playing = true;
	state.autoAdvance = autoAdvance;
	resume();
	renderControls();
};
const pause = () => {
	state.playing = false;
	audio.pause();
	renderControls();
};
const advance = () => {
	if (state.beat < currentChapter().beats.length - 1) goTo(state.chapter, state.beat + 1);
	else if (state.autoAdvance && state.chapter < review.chapters.length - 1) goTo(state.chapter + 1);
	else {
		state.playing = false;
		state.chapterFinished = true;
		state.pauseElapsed = pauseLength(currentBeat());
		renderControls();
	}
};

/* Any scroll, click or key inside an editor hands control to the viewer; resuming replays the current beat. */
const enterFree = () => {
	if (state.free) return;
	pause();
	state.free = true;
	app.classList.add('free');
	panes.forEach((pane) => {
		pane.stopCamera();
		pane.element.classList.remove('narrating');
	});
	link = null;
	renderControls();
};
const exitFree = () => {
	if (!state.free) return;
	state.free = false;
	app.classList.remove('free');
	locationHistory.length = 0;
	renderHistory();
	setScene(false);
	panes.forEach((pane) => pane.element.classList.add('narrating'));
	goTo(state.chapter, state.beat, 0);
};
const openFile = (filePath) => {
	enterFree();
	rememberLocation();
	showPanes([filePath], false);
	panes[0].revealFirstChange();
	renderTree(filePath);
};

/* Jumps between files keep a history, so Back (or Alt+Left) returns to where the viewer came from. */
const locationHistory = [];
const rememberLocation = () => {
	if (!panes.length) return;
	locationHistory.push(panes.map((pane) => ({ filePath: pane.filePath, scrolls: Object.values(pane.editors).map((editor) => editor.getScrollTop()) })));
	renderHistory();
};
const goBack = () => {
	const location = locationHistory.pop();
	renderHistory();
	if (!location) return;
	showPanes(location.map((item) => item.filePath), false);
	panes.forEach((pane, index) => pane.ready.then(() => Object.values(pane.editors).forEach((editor, editorIndex) => editor.setScrollTop(location[index].scrolls[editorIndex] ?? 0))));
	renderTree();
};
const openDefinition = (sourceEditor, resource, selectionOrPosition) => {
	const target = describeModel({ uri: resource });
	if (!target) return false;
	enterFree();
	rememberLocation();
	const sourcePane = panes.find((pane) => Object.values(pane.editors).includes(sourceEditor));
	if (!panes.some((pane) => pane.filePath === target.filePath)) showPanes([...(sourcePane ? [sourcePane.filePath] : []), target.filePath], false);
	const pane = panes.find((item) => item.filePath === target.filePath);
	const editor = pane.editors[target.view] ?? pane.editors.unified ?? pane.editors.modified;
	const range = selectionOrPosition && 'startLineNumber' in selectionOrPosition
		? selectionOrPosition
		: new monaco.Range(selectionOrPosition?.lineNumber ?? 1, selectionOrPosition?.column ?? 1, selectionOrPosition?.lineNumber ?? 1, selectionOrPosition?.column ?? 1);
	pane.ready.then(() => {
		editor.setSelection(range);
		editor.revealRangeInCenter(range);
		editor.focus();
	});
	renderTree(target.filePath);
	return true;
};
registerDefinitions({ monaco, review, modelsOf, describeModel, open: openDefinition });

const renderChapters = () => {
	chapterList.replaceChildren();
	review.chapters.forEach((chapter, chapterIndex) => {
		const row = element('button', `chapter-row${chapterIndex === state.chapter ? ' current' : ''}`, chapterList);
		element('span', 'chapter-number', row, String(chapterIndex + 1));
		element('span', 'chapter-name', row, chapter.title);
		row.addEventListener('click', () => navigate(chapterIndex, 0, 0));
		if (chapterIndex !== state.chapter) return;
		chapter.beats.forEach((beat, beatIndex) => {
			const status = beatIndex === state.beat ? ' current' : beatIndex < state.beat ? ' done' : '';
			const note = element('button', `note-row${status}`, chapterList, beat.note);
			note.addEventListener('click', () => navigate(chapterIndex, beatIndex, 0));
		});
	});
	kicker.textContent = `Chapter ${state.chapter + 1} of ${review.chapters.length}`;
	heading.textContent = currentChapter().title;
};
const renderTree = (focusedFile) => {
	tree.replaceChildren();
	const visible = new Set(panes.map((pane) => pane.filePath));
	const filePaths = Object.keys(review.files).sort();
	renderFiles(filePaths.filter((filePath) => review.files[filePath].status !== 'unchanged'), visible, focusedFile);
	const referenced = filePaths.filter((filePath) => review.files[filePath].status === 'unchanged');
	if (!referenced.length) return;
	element('div', 'section-heading tree-heading', tree, 'Referenced, unchanged');
	renderFiles(referenced, visible, focusedFile);
};
const renderFiles = (filePaths, visible, focusedFile) => {
	let folder = null;
	for (const filePath of filePaths) {
		const file = review.files[filePath];
		const slash = filePath.lastIndexOf('/');
		const directory = filePath.slice(0, slash + 1);
		if (directory !== folder) {
			folder = directory;
			element('div', 'tree-row tree-folder', tree, directory);
		}
		const classes = ['tree-row', 'tree-file', file.status, file.narrated ? '' : 'unnarrated', visible.has(filePath) ? 'visible' : '', filePath === focusedFile ? 'focused' : ''];
		const row = element('button', classes.filter(Boolean).join(' '), tree);
		row.style.paddingLeft = '22px';
		element('span', 'tree-name', row, filePath.slice(slash + 1));
		element('span', 'tree-status', row, file.status === 'unchanged' ? '' : file.status[0].toUpperCase());
		row.addEventListener('click', () => openFile(filePath));
	}
};
const navigate = (chapterIndex, beatIndex, offset) => {
	if (state.free) {
		state.free = false;
		app.classList.remove('free');
		setScene(true);
	}
	goTo(chapterIndex, beatIndex, offset);
};

const renderSegments = (bar, lengths, onSeek) => {
	bar.replaceChildren();
	return lengths.map((length, index) => {
		const segment = element('div', 'segment', bar);
		segment.style.flex = `${length} 1 0`;
		const fill = element('div', 'segment-fill', segment);
		segment.addEventListener('click', (event) => {
			const rectangle = segment.getBoundingClientRect();
			onSeek(index, ((event.clientX - rectangle.left) / rectangle.width) * length);
		});
		return { segment, fill };
	});
};
let chapterSegments = [];
let overallSegments = [];
const renderControls = () => {
	const chapterActive = state.playing && !state.autoAdvance;
	const allActive = state.playing && state.autoAdvance;
	chapterPlay.classList.toggle('active', chapterActive);
	chapterPlay.innerHTML = `<span class="icon">${chapterActive ? '❚❚' : '▶'}</span>${chapterActive ? 'Pause' : 'Play chapter'}`;
	allPlay.classList.toggle('active', allActive);
	allPlay.innerHTML = `<span class="icon">${allActive ? '❚❚' : '▶▶'}</span>${allActive ? 'Pause' : 'Play all'}`;
	previousButton.disabled = state.chapter === 0;
	nextButton.disabled = state.chapter === review.chapters.length - 1;
	nextButton.classList.toggle('attention', state.chapterFinished);
	chapterSegments = renderSegments(chapterBar, currentChapter().beats.map(beatLength), (beatIndex, offset) => navigate(state.chapter, beatIndex, offset));
	overallSegments = renderSegments(overallBar, review.chapters.map(chapterLength), (chapterIndex, offset) => {
		let remaining = offset;
		const beats = review.chapters[chapterIndex].beats;
		let beatIndex = 0;
		while (beatIndex < beats.length - 1 && remaining > beatLength(beats[beatIndex])) remaining -= beatLength(beats[beatIndex++]);
		navigate(chapterIndex, beatIndex, remaining);
	});
	speedControl.replaceChildren();
	for (const [key, { label }] of Object.entries(SPEEDS)) {
		const button = element('button', key === state.speed ? 'selected' : '', speedControl, label);
		button.addEventListener('click', () => {
			state.speed = key;
			audio.defaultPlaybackRate = audio.playbackRate = speed().rate;
			if (state.phase === 'pause' && state.playing) state.pauseStarted = performance.now() - state.pauseElapsed * 1000;
			renderControls();
		});
	}
	columnControl.replaceChildren();
	for (const columns of [1, 2]) {
		const button = element('button', columns === state.columns ? 'selected' : '', columnControl, columns === 1 ? 'One column' : 'Two columns');
		button.addEventListener('click', () => {
			if (state.columns === columns) return;
			state.columns = columns;
			const filePaths = panes.map((pane) => pane.filePath);
			showPanes(filePaths, true);
			if (state.free) panes.forEach((pane) => pane.revealFirstChange());
			else showSteps(false);
			renderControls();
		});
	}
};
chapterPlay.addEventListener('click', () => (state.playing && !state.autoAdvance ? pause() : play(false)));
allPlay.addEventListener('click', () => (state.playing && state.autoAdvance ? pause() : play(true)));
previousButton.addEventListener('click', () => navigate(state.chapter - 1, 0, 0));
nextButton.addEventListener('click', () => navigate(state.chapter + 1, 0, 0));
backButton.addEventListener('click', () => play(state.autoAdvance));
historyButton.addEventListener('click', goBack);
const renderHistory = () => {
	historyButton.disabled = !locationHistory.length;
};
document.addEventListener('keydown', (event) => {
	if (event.altKey && event.code === 'ArrowLeft') {
		event.preventDefault();
		goBack();
		return;
	}
	if (event.target.closest?.('.monaco-editor')) return;
	if (event.code === 'Space') {
		event.preventDefault();
		state.playing ? pause() : play(state.autoAdvance);
	}
});

const updateProgress = () => {
	const chapter = currentChapter();
	const inBeat = state.chapterFinished ? beatLength(currentBeat()) : elapsedInBeat();
	chapterSegments.forEach(({ segment, fill }, index) => {
		const fraction = index < state.beat ? 1 : index > state.beat ? 0 : Math.min(1, inBeat / beatLength(chapter.beats[index]));
		fill.style.transform = `scaleX(${fraction})`;
		segment.classList.toggle('current', index === state.beat);
	});
	const chapterElapsed = chapter.beats.slice(0, state.beat).reduce((sum, beat) => sum + beatLength(beat), 0) + inBeat;
	overallSegments.forEach(({ segment, fill }, index) => {
		const fraction = index < state.chapter ? 1 : index > state.chapter ? 0 : Math.min(1, chapterElapsed / chapterLength(chapter));
		fill.style.transform = `scaleX(${fraction})`;
		segment.classList.toggle('current', index === state.chapter);
	});
	chapterTime.textContent = `${formatTime(chapterElapsed)} / ${formatTime(chapterLength(chapter))}`;
	const totalBefore = review.chapters.slice(0, state.chapter).reduce((sum, item) => sum + chapterLength(item), 0);
	const total = review.chapters.reduce((sum, item) => sum + chapterLength(item), 0);
	overallTime.textContent = `${formatTime(totalBefore + chapterElapsed)} / ${formatTime(total)}`;
};

/* The connector runs only through the gap between panes, from the source row to the target row. */
const updateConnector = () => {
	const from = link && panes.find((pane) => pane.filePath === link.from.file);
	const to = link && panes.find((pane) => pane.filePath === link.to.file);
	if (!from || !to || state.free) {
		connector.classList.remove('visible');
		return;
	}
	const source = from.locateToken(link.from.token);
	const target = to.locateToken(link.to.token);
	const fromRectangle = from.element.getBoundingClientRect();
	const toRectangle = to.element.getBoundingClientRect();
	const leftToRight = fromRectangle.left < toRectangle.left;
	const startX = leftToRight ? fromRectangle.right + 4 : fromRectangle.left - 4;
	const endX = leftToRight ? toRectangle.left - 6 : toRectangle.right + 6;
	const startY = from.lineMiddle(source.editor, source.line);
	const endY = to.lineMiddle(target.editor, target.line);
	const middleX = (startX + endX) / 2;
	connector.querySelector('path').setAttribute('d', `M${startX},${startY} C${middleX},${startY} ${middleX},${endY} ${endX},${endY}`);
	const circle = connector.querySelector('circle');
	circle.setAttribute('cx', endX);
	circle.setAttribute('cy', endY);
	connector.classList.add('visible');
};

const tick = (now) => {
	if (state.playing) {
		if (state.phase === 'speech' && audio.ended) {
			state.phase = 'pause';
			state.pauseStarted = now;
			state.pauseElapsed = 0;
		}
		if (state.phase === 'pause') {
			state.pauseElapsed = (now - state.pauseStarted) / 1000;
			if (state.pauseElapsed >= pauseLimit()) advance();
		}
	}
	applySteps(false);
	updateProgress();
	syncDemo();
	showHighlights();
	updateConnector();
	requestAnimationFrame(tick);
};

/* Monaco measures glyph widths when an editor is created, so the fonts must be ready first. */
const fonts = ["400 14px 'JetBrains Mono'", "italic 400 14px 'JetBrains Mono'", "700 14px 'JetBrains Mono'", "400 14px 'Inter'"];
Promise.all(fonts.map((font) => document.fonts.load(font))).then(() => {
	state.chapter = -1;
	renderHistory();
	goTo(0);
	requestAnimationFrame(tick);
});
window.player = { state, goTo, navigate, play, pause, enterFree, openFile, panes: () => panes, monaco };
