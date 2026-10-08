/*
 * Media beside the code, captured from the real builds of both revisions. tools/capture.mjs passes the helpers;
 * each shot, recording or composition becomes a media name for scene.media and highlight targets.
 */
const PAGE = '<development URL that shows the change, never one with real user data>';
const ELEMENT = '<selector of the element the change affects>';
/* Maps a request for the components bundle to a file inside the built bundle, or null to let it through. */
const componentBundle = (url) => (url.host === '<bundle host>' && url.pathname.startsWith('<bundle prefix>') ? url.pathname.slice('<bundle prefix>'.length) : null);

const captureElements = async ({ browser, routeBundle, shoot, devtools }) => {
	for (const side of ['before', 'after']) {
		const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, ignoreHTTPSErrors: true, locale: 'en-US' });
		const page = await context.newPage();
		await routeBundle(page, side, componentBundle);
		await page.goto(PAGE, { timeout: 45000 });
		await page.locator(ELEMENT).waitFor();
		const inspector = await devtools(page, { viewport: { width: 1440, height: 810 }, panelWidth: 640, treeHeight: 380 });
		await inspector.reveal(ELEMENT, { rowsAbove: 2 });
		const host = inspector.selectedRow();
		const regions = { host };
		const tree = await inspector.tree.boundingBox();
		const hostBox = await host.boundingBox();
		await shoot(`tree-${side}`, inspector.page, { clip: { x: tree.x, y: hostBox.y - 21, width: Math.min(tree.width, 450), height: 156 }, regions });
		await inspector.close();
		await context.close();
	}
};

export default async (helpers) => {
	await captureElements(helpers);
	await helpers.compose('dom', [
		{ label: `Before · ${helpers.revisions.before.label}`, key: 'before', media: 'tree-before' },
		{ label: `After · ${helpers.revisions.after.label}`, key: 'after', media: 'tree-after' },
	]);
};
