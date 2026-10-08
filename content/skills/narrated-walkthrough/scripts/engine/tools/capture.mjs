import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildRevision, run } from './snapshot.mjs';

/*
 * Captures the media that code chapters show beside the code: screenshots, short recordings and the real DevTools
 * Elements panel, taken from the real builds of both revisions. The run's capture script (script.json capture,
 * default capture/capture.mjs) decides what to open and what to capture; this tool provides the helpers and writes
 * cache/media/<name>.png|webm with cache/media/media.json. Usage: node <engine>/tools/capture.mjs [name ...]
 */
const script = JSON.parse(readFileSync('script.json', 'utf8'));
const { repository, base, head } = script.review;
const demo = script.demo;
const output = path.resolve('cache/media');
const recording = path.resolve('cache/media-recording');
const capturePath = path.resolve(script.capture ?? 'capture/capture.mjs');
const only = new Set(process.argv.slice(2));
const manifestPath = path.join(output, 'media.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
mkdirSync(output, { recursive: true });

const revisions = Object.fromEntries(
	Object.entries({ before: base, after: head }).map(([side, revision]) => {
		const root = buildRevision({ repository, revision, commands: demo.build, environment: demo.environment, output: path.join(demo.bundle, demo.builtFile) });
		return [side, { revision, label: run('git', ['-C', repository, 'rev-parse', '--short=8', revision]), root, bundle: path.join(root, demo.bundle) }];
	}),
);

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png' };
/* Answers requests the matcher maps to a relative path with files from a local directory, such as a static Storybook build. */
const routeFiles = async (target, directory, matcher) => {
	await target.route(
		(url) => matcher(url) !== null,
		(route) => {
			const relativePath = matcher(new URL(route.request().url())) || 'index.html';
			const filePath = path.join(directory, relativePath);
			if (!existsSync(filePath)) return route.fulfill({ status: 404 });
			return route.fulfill({ contentType: contentTypes[path.extname(filePath)] ?? 'application/octet-stream', body: readFileSync(filePath) });
		},
	);
};
/* Serves a revision's built bundle in place of the one a real page loads, so that page runs that build. */
const routeBundle = (target, side, matcher) => routeFiles(target, revisions[side].bundle, matcher);

/* Regions are stored as fractions of the image, so the player can outline them at any size. */
const fractionsOf = (box, size, origin = { x: 0, y: 0 }) =>
	Object.fromEntries(
		[['x', (box.x - origin.x) / size.width], ['y', (box.y - origin.y) / size.height], ['width', box.width / size.width], ['height', box.height / size.height]].map(([key, value]) => [key, Number(value.toFixed(4))]),
	);
const measure = async (regionLocators = {}, size, origin) => {
	const regions = {};
	for (const [name, locator] of Object.entries(regionLocators)) {
		const box = await locator.boundingBox();
		if (box) regions[name] = fractionsOf(box, size, origin);
	}
	return regions;
};
const wanted = (name) => only.size === 0 || only.has(name);
const remember = (name, entry) => {
	manifest[name] = entry;
	console.log('captured', name, entry.file, Object.keys(entry.regions));
};

const freePort = () =>
	new Promise((resolve) => {
		const server = createServer().listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
const port = await freePort();
/* The DevTools frontend runs as an ordinary page connected over the debugging port, so it can be driven and captured. */
const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--lang=en-US'] });

/* A still image of the page, or of the part that clip gives as a locator or a box. */
const shoot = async (name, page, { clip, regions } = {}) => {
	if (!wanted(name)) return;
	const file = `${name}.png`;
	const box = !clip ? { x: 0, y: 0, ...page.viewportSize() } : typeof clip.boundingBox === 'function' ? await clip.boundingBox() : clip;
	await page.screenshot({ path: path.join(output, file), clip: box });
	remember(name, { kind: 'image', file, width: Math.round(box.width), height: Math.round(box.height), regions: await measure(regions, box, box) });
};

/* A short video: action(page) drives a fresh page and may return region locators measured at its end. */
const record = async (name, action, { viewport = { width: 1280, height: 720 }, contextOptions = {} } = {}) => {
	if (!wanted(name)) return;
	rmSync(recording, { recursive: true, force: true });
	const context = await browser.newContext({ ...contextOptions, viewport, recordVideo: { dir: recording, size: viewport } });
	const page = await context.newPage();
	const started = Date.now();
	let regions = {};
	let from = 0;
	try {
		const result = await action(page, { start: () => (from = (Date.now() - started) / 1000) });
		regions = await measure(result?.regions, viewport);
	} finally {
		await page.close();
		await context.close();
	}
	const file = `${name}.webm`;
	run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', from.toFixed(2), '-i', await page.video().path(), '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-an', path.join(output, file)], { timeout: 300000 });
	remember(name, { kind: 'video', file, width: viewport.width, height: viewport.height, regions });
};

/* Drags a DevTools splitter so its edge lands at the given coordinate. */
const dragResizer = async (inspector, resizer, axis, to) => {
	const box = await resizer.boundingBox();
	const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await inspector.mouse.move(center.x, center.y);
	await inspector.mouse.down();
	await inspector.mouse.move(axis === 'x' ? to : center.x, axis === 'y' ? to : center.y, { steps: 12 });
	await inspector.mouse.up();
	await inspector.waitForTimeout(300);
};

/*
 * Opens the real DevTools for a page, docked beside a screencast of it, the way a developer sees it. panelWidth
 * widens the DevTools side and treeHeight gives the Elements tree that much room above the Styles pane.
 * reveal(selector) selects that element in the Elements panel through the console's inspect(); row(text) locates
 * a node's row for a region; tree is the Elements tree, for clipping a shot to it.
 */
const devtools = async (page, { viewport = { width: 1280, height: 720 }, panelWidth, treeHeight } = {}) => {
	const session = await page.context().newCDPSession(page);
	const { targetInfo } = await session.send('Target.getTargetInfo');
	await session.detach();
	const context = await browser.newContext({ viewport, locale: 'en-US', colorScheme: 'dark' });
	const inspector = await context.newPage();
	await inspector.goto(`http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${targetInfo.targetId}`);
	await inspector.locator('.elements-disclosure li').first().waitFor({ timeout: 20000 });
	await inspector.waitForTimeout(800);
	const resizers = inspector.locator('.shadow-split-widget-resizer');
	const isVertical = async (locator) => {
		const box = await locator.boundingBox();
		return box && box.height > box.width;
	};
	for (const resizer of await resizers.all()) {
		const box = await resizer.boundingBox();
		if (!box) continue;
		if (panelWidth && (await isVertical(resizer)) && box.height >= viewport.height - 2) await dragResizer(inspector, resizer, 'x', viewport.width - panelWidth);
	}
	for (const resizer of await resizers.all()) {
		const box = await resizer.boundingBox();
		if (!box) continue;
		/* The Elements panel's tree and Styles split is the horizontal splitter nearest the top. */
		if (treeHeight && !(await isVertical(resizer)) && box.y < viewport.height * 0.8) {
			await dragResizer(inspector, resizer, 'y', treeHeight);
			break;
		}
	}
	const runInConsole = async (expression) => {
		await inspector.keyboard.press('Escape');
		await inspector.waitForTimeout(600);
		await inspector.keyboard.type(expression);
		await inspector.keyboard.press('Enter');
		await inspector.waitForTimeout(600);
		await inspector.keyboard.press('Escape');
		await inspector.waitForTimeout(500);
	};
	return {
		page: inspector,
		/* rowsAbove scrolls the tree so the selected node sits near the top with that many ancestor rows above it. */
		reveal: async (selector, { expand = true, rowsAbove = 3 } = {}) => {
			await runInConsole(`inspect(document.querySelector(${JSON.stringify(selector)}))`);
			if (expand) {
				await inspector.keyboard.press('ArrowRight');
				await inspector.waitForTimeout(500);
			}
			await inspector.locator('.elements-disclosure li[role="treeitem"].selected').evaluate((row, rows) => {
				let scroller = row.parentNode;
				while (scroller && !(scroller instanceof Element && scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
					scroller = scroller.parentNode ?? scroller.host;
				}
				if (!scroller) return;
				scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - rows * row.getBoundingClientRect().height;
			}, rowsAbove);
			await inspector.waitForTimeout(300);
		},
		row: (text) => inspector.locator('.elements-disclosure li[role="treeitem"]').filter({ hasText: text }).first(),
		selectedRow: () => inspector.locator('.elements-disclosure li[role="treeitem"].selected'),
		tree: inspector.locator('.elements-disclosure'),
		close: () => context.close(),
	};
};

/* Lays captured images out under labels and captures the result as one image, keeping each image's regions under "<label key>.<region>". */
const compose = async (name, items, { direction = 'column', width = 1280 } = {}) => {
	if (!wanted(name)) return;
	const page = await (await browser.newContext({ viewport: { width, height: 400 }, deviceScaleFactor: 1 })).newPage();
	const sources = items.map((item) => ({ ...item, entry: manifest[item.media] }));
	const missing = sources.find((item) => !item.entry || item.entry.kind !== 'image');
	if (missing) throw new Error(`compose ${name}: ${missing.media} is not a captured image`);
	await page.setContent(`<!doctype html><style>
		body { margin: 0; background: #181818; font: 600 13px 'Segoe UI', sans-serif; color: #cccccc; }
		main { display: flex; flex-direction: ${direction}; gap: 14px; padding: 14px; width: max-content; }
		figure { margin: 0; } figcaption { padding: 0 2px 8px; letter-spacing: 0.08em; text-transform: uppercase; }
		img { display: block; border: 1px solid #333333; border-radius: 6px; }
	</style><main>${sources.map((item, index) => `<figure><figcaption>${item.label}</figcaption><img id="i${index}" src="data:image/png;base64,${readFileSync(path.join(output, item.entry.file)).toString('base64')}" width="${item.entry.width}" height="${item.entry.height}"></figure>`).join('')}</main>`);
	const main = page.locator('main');
	const box = await main.boundingBox();
	await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
	const file = `${name}.png`;
	await main.screenshot({ path: path.join(output, file) });
	const regions = {};
	for (const [index, item] of sources.entries()) {
		const image = await page.locator(`#i${index}`).boundingBox();
		regions[item.key] = fractionsOf(image, box, box);
		for (const [region, fraction] of Object.entries(item.entry.regions)) {
			regions[`${item.key}.${region}`] = fractionsOf(
				{ x: image.x + fraction.x * image.width, y: image.y + fraction.y * image.height, width: fraction.width * image.width, height: fraction.height * image.height },
				box,
				box,
			);
		}
	}
	await page.context().close();
	remember(name, { kind: 'image', file, width: Math.round(box.width), height: Math.round(box.height), regions });
};

try {
	const capture = await import(pathToFileURL(capturePath).href);
	await capture.default({ browser, revisions, routeFiles, routeBundle, shoot, record, devtools, compose });
} finally {
	await browser.close();
	rmSync(recording, { recursive: true, force: true });
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
console.log('media:', Object.keys(manifest).join(', '));
