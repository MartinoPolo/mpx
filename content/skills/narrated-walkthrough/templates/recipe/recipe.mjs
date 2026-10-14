/*
 * <What this recipe demonstrates and which condition each scene sets up.> The verdict is derived from what
 * the frame observed, so a caption cannot claim a fix that is not there.
 */
export const ready = (frame) =>
	frame.waitForFunction(() => customElements.get('my-component') && document.querySelector('my-component').shadowRoot?.querySelector('button'));

export const prepare = (frame, scene) => frame.evaluate((scene) => window.demo.reset(scene), scene);

/* click moves a visible cursor; press shows each key as a keycap, so use it for every key instead of page.keyboard. */
export const act = async ({ locator, click, press }) => {
	await click(locator('my-component button'));
	await press('Tab');
};

export const result = async (frame) => {
	const observed = await frame.evaluate(() => window.demo.observed());
	const good = observed === '<expected>';
	await frame.evaluate((good) => window.demo.show(good), good);
	return { verdict: good ? '<what the user got>' : '<what went wrong>', good, observed };
};
