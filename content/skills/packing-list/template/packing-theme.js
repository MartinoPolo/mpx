// Resolves light or dark into data-theme before the list renders, so the CSS needs one dark block. Order of precedence:
// the viewer's choice on this device, then a theme the artifact host already set, then the system setting.
// Contract: [data-action="theme"] buttons toggle it; the app shows on them the theme they switch to.
(function () {
	const storageKey = 'packing-theme';
	const root = document.documentElement;
	const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

	function readChoice() {
		try {
			return localStorage.getItem(storageKey);
		} catch {
			return null;
		}
	}

	function saveChoice(theme) {
		try {
			localStorage.setItem(storageKey, theme);
		} catch {
			// Private windows can refuse storage; the choice then lasts for this visit.
		}
	}

	let followsSystem = false;
	const choice = readChoice();
	if (choice) root.dataset.theme = choice;
	else if (!root.dataset.theme) followsSystem = true;
	if (followsSystem) root.dataset.theme = systemDark.matches ? 'dark' : 'light';

	systemDark.addEventListener('change', () => {
		if (followsSystem) root.dataset.theme = systemDark.matches ? 'dark' : 'light';
	});
	document.addEventListener('click', (event) => {
		if (!event.target.closest('[data-action="theme"]')) return;
		followsSystem = false;
		root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
		saveChoice(root.dataset.theme);
	});
})();
