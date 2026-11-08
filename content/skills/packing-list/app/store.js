// Keeps ticks and list edits in this browser. When the page runs as a published Claude artifact it also syncs them
// through the artifact's shared database, so every device and everyone the list is shared with sees the same state.
import { mergeShared, same } from './merge.js';

const prefix = window.PACKING_TRIP.storageKey;
const names = ['checked', 'edits'];
const changeListeners = [];
const syncListeners = [];
let sharedDocument = null;
let syncFailing = false;
let writing = false;
let dirty = false;

function read(name, fallback) {
	try {
		return JSON.parse(localStorage.getItem(`${prefix}:${name}`)) ?? fallback;
	} catch {
		return fallback;
	}
}

function writeLocal(name, value) {
	try {
		localStorage.setItem(`${prefix}:${name}`, JSON.stringify(value));
	} catch {
		// Private windows can refuse storage; the page still works for this visit.
	}
}

const localState = () => Object.fromEntries(names.map((name) => [name, read(name, null)]));
// The shared copy this view last confirmed; what differs from it locally is this view's own unsent change.
let base = read('base', null);

function setBase(shared) {
	base = shared;
	writeLocal('base', shared);
}

// A viewer the artifact does not let write (such as a visitor from another organization through a public link) keeps
// changes in this browser only; the page says so instead of letting them vanish on the next shared update.
function setSyncFailing(failing) {
	if (failing === syncFailing) return;
	syncFailing = failing;
	for (const listener of syncListeners) listener(failing);
}

function adopt(state) {
	for (const name of names) {
		if (state[name] == null || same(state[name], read(name, null))) continue;
		writeLocal(name, state[name]);
		for (const listener of changeListeners) listener(name);
	}
}

// The store allows one write at a time per document, so a burst of ticks collapses into one trailing write. The write
// merges into a fresh read, because whole-document writes are last-writer-wins.
async function flushShared() {
	if (writing) {
		dirty = true;
		return;
	}
	writing = true;
	do {
		dirty = false;
		try {
			const fresh = await sharedDocument.get();
			const merged = mergeShared(base, localState(), fresh.exists ? fresh.data() : {});
			adopt(merged);
			await sharedDocument.set(merged);
			setBase(merged);
			setSyncFailing(false);
		} catch {
			// The local copy stays; the next change retries.
			setSyncFailing(true);
		}
	} while (dirty);
	writing = false;
}

export const store = {
	read,
	write(name, value) {
		writeLocal(name, value);
		if (sharedDocument) flushShared();
	},
	// Per-viewer preferences, such as the chosen layout, stay in this browser.
	remember: writeLocal,
	onSharedChange(listener) {
		changeListeners.push(listener);
	},
	onSyncFailing(listener) {
		syncListeners.push(listener);
		listener(syncFailing);
	},
};

window.claude?.use('db').then((db) => {
	if (!db) {
		setSyncFailing(Boolean(window.PACKING_ARTIFACT));
		return;
	}
	const document = db.doc(`lists/${prefix}`);
	document.onSnapshot((snapshot) => {
		// A copy cached on an earlier visit can be older than the store, and a pending write is this view's own echo.
		if (snapshot.metadata?.fromCache || snapshot.metadata?.hasPendingWrites) return;
		sharedDocument = document;
		const shared = snapshot.exists ? snapshot.data() : {};
		const local = localState();
		// Without a confirmed shared copy, this browser cannot tell its own changes from a stale copy, so the store wins.
		const merged = base ? mergeShared(base, local, shared) : Object.fromEntries(names.map((name) => [name, shared[name] ?? local[name]]));
		adopt(merged);
		setBase(shared);
		if (!same(merged, shared)) flushShared();
	}, () => setSyncFailing(true));
});
