// Drags item rows by their grip. A copy of the row follows the pointer and a line marks where it will land; the list
// itself changes only on release, so nothing else on the page moves while dragging. Contract for the markup:
//   [data-drop-list="listId"]  a section's or bag's container of item rows, a direct child of its [data-category-block]
//   [data-item-row="itemId"]   a direct child of a drop list
// Pointer events rather than HTML drag and drop, which phones do not support.
const edgeSize = 64;
const scrollStep = 14;
let drag = null;

const isRow = (node) => node?.matches('[data-item-row]');

// Midpoint of the row under the pointer, or the start or end of the section or bag under it.
function findTarget(x, y) {
	const under = document.elementFromPoint(x, y);
	const overRow = under?.closest('[data-item-row]');
	if (overRow?.parentElement.matches('[data-drop-list]')) {
		const rect = overRow.getBoundingClientRect();
		const below = y > rect.top + rect.height / 2;
		const next = overRow.nextElementSibling;
		return { list: overRow.parentElement, before: below ? (isRow(next) ? next : null) : overRow, rect, edge: below ? rect.bottom : rect.top };
	}
	const list = under?.closest('[data-category-block]')?.querySelector(':scope > [data-drop-list]');
	if (!list) return null;
	const rows = list.querySelectorAll(':scope > [data-item-row]');
	const rect = list.getBoundingClientRect();
	if (!rows.length) return { list, before: null, rect, edge: rect.top + rect.height / 2 };
	const first = rows[0].getBoundingClientRect();
	if (y < first.top) return { list, before: rows[0], rect: first, edge: first.top };
	const last = rows[rows.length - 1].getBoundingClientRect();
	return { list, before: null, rect: last, edge: last.bottom };
}

// Null also where the row would land on its own spot.
function moveTarget(x, y) {
	const target = findTarget(x, y);
	const staysPut = target && target.list === drag.row.parentElement && (target.before === drag.row || target.before === drag.row.nextElementSibling);
	return staysPut ? null : target;
}

function frame() {
	if (!drag) return;
	const direction = drag.y < edgeSize ? -1 : drag.y > window.innerHeight - edgeSize ? 1 : 0;
	if (direction) window.scrollBy(0, direction * scrollStep);
	drag.ghost.style.transform = `translate(${drag.x - drag.startX}px, ${drag.y - drag.startY}px) rotate(1.5deg)`;

	drag.target = moveTarget(drag.x, drag.y);
	drag.marker.hidden = !drag.target;
	if (drag.target) {
		const { rect, edge } = drag.target;
		drag.marker.style.width = `${rect.width}px`;
		drag.marker.style.transform = `translate(${rect.left}px, ${edge}px)`;
	}
	drag.frameId = requestAnimationFrame(frame);
}

// The copy carries the row's tick state, which lives in properties that cloning leaves behind.
function makeGhost(row) {
	const ghost = row.cloneNode(true);
	const originals = row.querySelectorAll('input');
	ghost.querySelectorAll('input').forEach((input, index) => {
		input.checked = originals[index].checked;
		input.indeterminate = originals[index].indeterminate;
	});
	for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id');
	ghost.removeAttribute('data-item-row');
	ghost.classList.add('drag-ghost');
	const rect = row.getBoundingClientRect();
	Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
	return ghost;
}

function stop(event) {
	if (!drag || event.pointerId !== drag.pointerId) return;
	// The release point counts even when no frame ran since the last move.
	const target = event.type === 'pointerup' ? moveTarget(event.clientX, event.clientY) : null;
	const { row, handle, ghost, marker, onDrop, frameId } = drag;
	drag = null;
	cancelAnimationFrame(frameId);
	ghost.remove();
	marker.remove();
	row.classList.remove('dragging');
	document.documentElement.classList.remove('dragging-item');
	for (const type of ['pointermove', 'pointerup', 'pointercancel']) handle.removeEventListener(type, handlers[type]);
	if (!target) return;
	onDrop({
		itemId: row.dataset.itemRow,
		fromList: row.parentElement.dataset.dropList,
		toList: target.list.dataset.dropList,
		beforeId: target.before?.dataset.itemRow ?? null,
	});
}

const handlers = {
	pointermove(event) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		drag.x = event.clientX;
		drag.y = event.clientY;
	},
	pointerup: stop,
	pointercancel: stop,
};

export function startDrag(event, onDrop) {
	if (event.button > 0 || drag) return;
	event.preventDefault();
	const handle = event.currentTarget;
	const row = handle.closest('[data-item-row]');
	handle.setPointerCapture(event.pointerId);
	for (const type of ['pointermove', 'pointerup', 'pointercancel']) handle.addEventListener(type, handlers[type]);
	const marker = document.createElement('div');
	marker.className = 'drop-marker';
	marker.hidden = true;
	const ghost = makeGhost(row);
	document.body.append(ghost, marker);
	row.classList.add('dragging');
	document.documentElement.classList.add('dragging-item');
	drag = { row, handle, ghost, marker, onDrop, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, target: null };
	drag.frameId = requestAnimationFrame(frame);
}
