/*
 * <What this recipe demonstrates and which condition each scene sets up.> The verdict is derived from what
 * the frame observed, so a caption cannot claim a fix that is not there.
 */
export const ready = (frame) =>
	frame.waitForFunction(() => customElements.get('my-component') && document.querySelector('my-component').shadowRoot?.querySelector('button'));

export const prepare = (frame, scene) => frame.evaluate((scene) => window.demo.reset(scene), scene);

export const act = ({ locator, click }) => click(locator('my-component button'));

export const result = async (frame) => {
	const observed = await frame.evaluate(() => window.demo.observed());
	const good = observed === '<expected>';
	await frame.evaluate((good) => window.demo.show(good), good);
	return { verdict: good ? '<what the user got>' : '<what went wrong>', good, observed };
};
