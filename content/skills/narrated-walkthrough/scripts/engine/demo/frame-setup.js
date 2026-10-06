/*
 * Loaded first by a recipe's frame.html: it loads the bundle files named in data-bundle from the revision in the
 * query, so both sides run the build of their own commit. With data-hold-timers="<ms>", timers at least that long are held
 * until the recipe releases them, so a component that resets its result keeps it on screen for the narration.
 */
(() => {
	const holdFrom = Number(document.currentScript.dataset.holdTimers ?? Infinity);
	const heldTimers = [];
	const setTimeoutNow = window.setTimeout.bind(window);
	window.setTimeout = (callback, delay = 0, ...parameters) => {
		if (delay < holdFrom) return setTimeoutNow(callback, delay, ...parameters);
		heldTimers.push(() => callback(...parameters));
		return 0;
	};
	window.demoFrame = {
		releaseHeldTimers: () => heldTimers.splice(0).forEach((timer) => timer()),
	};
	const side = new URLSearchParams(location.search).get('side');
	for (const name of document.currentScript.dataset.bundle.split(' ')) {
		document.write(name.endsWith('.css') ? `<link rel="stylesheet" href="/${side}/${name}">` : `<script type="module" src="/${side}/${name}"><\/script>`);
	}
})();
