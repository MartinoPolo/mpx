import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildRevision, run } from './snapshot.mjs';

/*
 * Records a before-and-after demo as a video: the real bundle of each revision runs side by side in the stage,
 * and the run's recipe (script.json demo.recipe, a folder with frame.html and recipe.mjs) sets up each scene,
 * acts on both sides and reports what it observed. Captions come from those observations, not from the script.
 */
const script = JSON.parse(readFileSync('script.json', 'utf8'));
const { repository, base, head } = script.review;
const demo = script.demo;
const stageDirectory = fileURLToPath(new URL('../demo/', import.meta.url));
const recipeDirectory = path.resolve(demo.recipe);
const recipe = await import(pathToFileURL(path.join(recipeDirectory, 'recipe.mjs')).href);
const output = path.resolve('cache/demo');
const sides = {
	before: { revision: base, title: demo.sides?.before ?? 'Before the change' },
	after: { revision: head, title: demo.sides?.after ?? 'After the change' },
};
for (const side of Object.values(sides)) {
	side.label = run('git', ['-C', repository, 'rev-parse', '--short=8', side.revision]);
	side.root = buildRevision({ repository, revision: side.revision, commands: demo.build, environment: demo.environment, output: path.join(demo.bundle, demo.builtFile) });
}

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
	const [, first, ...rest] = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).split('/');
	const filePath = sides[first]
		? path.join(sides[first].root, demo.bundle, ...rest)
		: first === 'recipe'
			? path.join(recipeDirectory, ...rest)
			: path.join(stageDirectory, first || 'stage.html', ...rest);
	if (!existsSync(filePath)) {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] ?? 'application/octet-stream' });
	response.end(readFileSync(filePath));
});
await new Promise((resolve) => server.listen(0, 'localhost', resolve));
const origin = `http://localhost:${server.address().port}`;

/*
 * Each clip starts and ends at rest, so the player can start one when the narration reaches it and hold
 * its last frame without ever stopping mid-action: "<scene>" shows the scene, "<scene>-<side>" is one side acting.
 */
const recording = path.resolve('cache/recording');
rmSync(recording, { recursive: true, force: true });
const viewport = { width: 1280, height: 720 };
const browser = await chromium.launch();
const clips = {};
const regions = {};
let videoPath;
try {
	const context = await browser.newContext({ viewport, recordVideo: { dir: recording, size: viewport } });
	const page = await context.newPage();
	const recordingStart = Date.now();
	const now = () => (Date.now() - recordingStart) / 1000;
	const clip = async (id, action) => {
		const from = now();
		await action();
		clips[id] = { from, to: now() };
		/* A still tail keeps the result on screen for the few frames a player may run past the end. */
		await page.waitForTimeout(500);
	};
	page.on('pageerror', (error) => console.log('pageerror', error.message));
	await page.goto(`${origin}/stage.html`);
	const stageSides = Object.fromEntries(Object.entries(sides).map(([side, { title, label }]) => [side, { title, revision: label }]));
	await page.evaluate(([kicker, sides]) => stage.setup(kicker, sides), [demo.kicker, stageSides]);
	const locators = Object.fromEntries(Object.keys(sides).map((side) => [side, page.frameLocator(`#${side} iframe`)]));
	const frameOf = async (side) => (await page.locator(`#${side} iframe`).elementHandle()).contentFrame();
	for (const side of Object.keys(sides)) await recipe.ready(await frameOf(side));
	await page.waitForTimeout(600);

	/*
	 * Regions are stored as fractions of the frame, so the player can outline them at any video size. They are
	 * measured once the first scene is set up, because readouts change height when filled.
	 */
	const measureRegions = async () => {
		const addRegion = (name, box) => {
			regions[name] = Object.fromEntries(
				[['x', box.x / viewport.width], ['y', box.y / viewport.height], ['width', box.width / viewport.width], ['height', box.height / viewport.height]].map(([key, value]) => [key, Number(value.toFixed(4))]),
			);
		};
		for (const element of await page.locator('body > header [data-region]').all()) addRegion(await element.getAttribute('data-region'), await element.boundingBox());
		for (const side of Object.keys(sides)) {
			for (const element of await page.locator(`#${side}[data-region], #${side} [data-region]`).all()) addRegion(`${side}.${await element.getAttribute('data-region')}`, await element.boundingBox());
			for (const element of await locators[side].locator('[data-region]').all()) addRegion(`${side}.${await element.getAttribute('data-region')}`, await element.boundingBox());
		}
	};

	/* A visible cursor travels to the target and ripples, so the viewer sees what was clicked before it reacts. */
	const click = async (target) => {
		const box = await target.boundingBox();
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await page.evaluate(([x, y]) => stage.moveCursor(x, y), [x, y]);
		await page.waitForTimeout(1100);
		await page.evaluate(([x, y]) => stage.ripple(x, y), [x, y]);
		await page.mouse.click(x, y);
		await page.evaluate(([x, y]) => stage.moveCursor(x + 30, y + 45), [x, y]);
		await page.waitForTimeout(250);
	};
	const actOn = async (side, scene) => {
		/* A still lead-in absorbs the few frames a player may run past the end of the previous clip. */
		await page.waitForTimeout(500);
		const frame = await frameOf(side);
		await page.evaluate((side) => stage.focus(side), side);
		await recipe.act({ frame, locator: (selector) => locators[side].locator(selector), click, scene, demo });
		const { verdict, good, observed } = await recipe.result(frame, demo, scene);
		await page.evaluate(([side, text, good]) => stage.verdict(side, text, good), [side, verdict, good]);
		console.log(scene.id, side, observed, verdict);
		await page.waitForTimeout(demo.holdAfterAction * 1000);
	};

	for (const scene of demo.scenes) {
		for (const side of Object.keys(sides)) await recipe.prepare(await frameOf(side), scene, demo);
		await page.evaluate(([title, subtitle]) => {
			stage.focus(null);
			stage.scene(title, subtitle);
		}, [scene.title, scene.subtitle]);
		if (Object.keys(regions).length === 0) {
			await page.waitForTimeout(300);
			await measureRegions();
		}
		await clip(scene.id, () => page.waitForTimeout(800));
		for (const side of Object.keys(sides)) await clip(`${scene.id}-${side}`, () => actOn(side, scene));
	}
	await page.close();
	videoPath = await page.video().path();
	await context.close();
} finally {
	await browser.close();
	server.close();
}

/* The recording starts before the bundles load, so the encoded video begins with the first clip. */
const start = clips[demo.scenes[0].id].from;
mkdirSync(output, { recursive: true });
const video = path.join(output, 'demo.webm');
run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', start.toFixed(2), '-i', videoPath, '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-an', video], { timeout: 300000 });
const shifted = Object.fromEntries(Object.entries(clips).map(([id, { from, to }]) => [id, { from: Number((from - start).toFixed(2)), to: Number((to - start).toFixed(2)) }]));
writeFileSync(path.join(output, 'demo.json'), `${JSON.stringify({ video: 'demo.webm', clips: shifted, regions }, null, '\t')}\n`);
console.log('demo:', video, shifted, Object.keys(regions));
