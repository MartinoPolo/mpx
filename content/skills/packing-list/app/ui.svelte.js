// What the viewer has open: the layout, the section or bag editor ({ kind, id }, id null for a new one) and the bag
// picker ({ itemId, pieceIndex, badge }).
import { store } from './store.js';

export const layouts = ['categories', 'bags'];
const savedLayout = store.read('layout');

export const ui = $state({
	layout: layouts.includes(savedLayout) ? savedLayout : layouts[0],
	editing: null,
	picker: null,
	syncFailing: false,
	// Hides packed rows and finished sections or bags; remembered per device, not shared.
	unpackedOnly: store.read('unpackedOnly') === true,
});
store.onSyncFailing((failing) => (ui.syncFailing = failing));

export function setUnpackedOnly(unpackedOnly) {
	ui.unpackedOnly = unpackedOnly;
	store.remember('unpackedOnly', unpackedOnly);
}

export function setLayout(layout) {
	ui.layout = layout;
	ui.editing = null;
	ui.picker = null;
	store.remember('layout', layout);
}

export const motionDuration = (duration) => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration);
