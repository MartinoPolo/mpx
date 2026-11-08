// Sections, bags, items and ticks as edited on the page (deleted, added, recounted, renamed, reordered, moved, ticked),
// layered over packing-data.js and saved through the store.
import { SvelteSet } from 'svelte/reactivity';
import { store } from './store.js';

const trip = window.PACKING_TRIP;
export const maxCount = 12;
const clampCount = (count) => Math.min(Math.max(count, 1), maxCount);
const defaultBags = [
	{ id: 'kufr', title: 'Kufr', emoji: '🧳' },
	{ id: 'batoh', title: 'Batoh', emoji: '🎒' },
	{ id: 'na-sebe', title: 'Na sebe', emoji: '🧍' },
];
// The main bag is where every item starts unless packing-data.js or the viewer puts it elsewhere: the trip's `mainBag`,
// else the first bag. It stays top-level and cannot be deleted, wherever it sits in the order.
const mainBagId = (bags) => (bags.some((bag) => bag.id === trip.mainBag) ? trip.mainBag : bags[0].id);
const homeCategory = new Map(trip.categories.flatMap((category) => category.items.map((item) => [item.id, category.id])));
export const pieceKey = (itemId, index) => `${itemId}:${index}`;
// A row shows the pieces in pieceIndexes: all of them in the section layout, those packed in its bag in the bag layout.
export const rowKeys = (row) => row.pieceIndexes.map((index) => pieceKey(row.id, index));
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}`;
const cleanTitle = (title) => String(title ?? '').trim();

function normalizeEdits(stored) {
	return {
		deleted: stored.deleted ?? [],
		added: stored.added ?? [],
		counts: stored.counts ?? {},
		order: stored.order ?? {},
		sectionOf: stored.sectionOf ?? {},
		sections: stored.sections ?? {},
		addedSections: stored.addedSections ?? [],
		bags: stored.bags ?? null,
		bagOf: stored.bagOf ?? {},
		pieceBagOf: stored.pieceBagOf ?? {},
		bagOrder: stored.bagOrder ?? {},
	};
}

// Ids missing from the saved order (new or restored items) keep their data order after the arranged ones.
function arrange(items, orderedIds = []) {
	const rank = new Map(orderedIds.map((id, index) => [id, index]));
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => (rank.get(a.item.id) ?? Infinity) - (rank.get(b.item.id) ?? Infinity) || a.index - b.index)
		.map(({ item }) => item);
}

// Added sections go before the optional ones, which stay last.
function sectionsOf(edits) {
	const renamed = trip.categories.map(({ items, ...category }) => ({ ...category, ...edits.sections[category.id] }));
	const added = edits.addedSections.map((section) => ({ ...section, custom: true }));
	const firstOptional = renamed.findIndex((category) => category.optional);
	const insertAt = firstOptional < 0 ? renamed.length : firstOptional;
	return [...renamed.slice(0, insertAt), ...added, ...renamed.slice(insertAt)];
}

// Two levels only: a bag may sit inside a top-level bag, never inside an inner one.
// Returned in tree order: each top-level bag followed by its inner bags.
function bagsOf(edits) {
	const bags = edits.bags ?? trip.bags ?? defaultBags;
	const mainId = mainBagId(bags);
	const topLevel = new Set(bags.filter((bag) => bag.id === mainId || !bag.parent).map((bag) => bag.id));
	const flat = bags.map((bag) => {
		const parent = bag.id !== mainId && topLevel.has(bag.parent) ? bag.parent : undefined;
		return { id: bag.id, title: bag.title, emoji: bag.emoji, ...(parent && { parent }) };
	});
	return flat.filter((bag) => !bag.parent).flatMap((bag) => [bag, ...flat.filter((child) => child.parent === bag.id)]);
}

function resolvedItems(edits) {
	const deleted = new Set(edits.deleted);
	const bags = bagsOf(edits);
	const categoryIds = new Set(sectionsOf(edits).map((category) => category.id));
	const bagIds = new Set(bags.map((bag) => bag.id));
	const known = (ids, id) => (ids.has(id) ? id : undefined);
	return [
		...trip.categories.flatMap((category) => category.items.map((item) => ({ ...item, categoryId: category.id, bag: item.bag ?? category.bag }))),
		...edits.added,
	]
		.filter((item) => !deleted.has(item.id))
		.map((item) => {
			const count = edits.counts[item.id] ?? item.count;
			const bagId = known(bagIds, edits.bagOf[item.id]) ?? known(bagIds, item.bag) ?? mainBagId(bags);
			return {
				...item,
				count,
				categoryId: known(categoryIds, edits.sectionOf[item.id]) ?? known(categoryIds, item.categoryId) ?? trip.categories[0].id,
				bagId,
				pieceBagIds: Array.from({ length: count }, (_, index) => known(bagIds, edits.pieceBagOf[pieceKey(item.id, index)]) ?? bagId),
				pieceIndexes: Array.from({ length: count }, (_, index) => index),
			};
		});
}

const findItem = (edits, itemId) => resolvedItems(edits).find((item) => item.id === itemId);

// The item keeps one bag of its own; only pieces packed elsewhere are stored one by one.
function writePieces(edits, item, pieceBagIds) {
	for (const key of Object.keys(edits.pieceBagOf)) if (key.startsWith(`${item.id}:`)) delete edits.pieceBagOf[key];
	const base = pieceBagIds.includes(item.bagId) ? item.bagId : pieceBagIds[0];
	edits.bagOf[item.id] = base;
	pieceBagIds.forEach((bagId, index) => {
		if (bagId !== base) edits.pieceBagOf[pieceKey(item.id, index)] = bagId;
	});
}

class PackingList {
	edits = $state(normalizeEdits(store.read('edits', {})));
	// Kept apart from the rows, so a deleted and later restored item keeps its ticks.
	checked = new SvelteSet(store.read('checked', []));

	bags = $derived.by(() => {
		const bags = bagsOf(this.edits);
		const mainId = mainBagId(bags);
		return bags.map((bag) => ({ ...bag, main: bag.id === mainId, hasChildren: bags.some((child) => child.parent === bag.id) }));
	});

	categories = $derived.by(() => {
		const items = resolvedItems(this.edits);
		return sectionsOf(this.edits).map((category) => {
			const categoryItems = arrange(items.filter((item) => item.categoryId === category.id), this.edits.order[category.id]);
			return { ...category, items: categoryItems, deletable: Boolean(category.custom) && categoryItems.length === 0 };
		});
	});

	// Top-level bags with their inner bags. An item whose pieces are spread over bags shows up in each of them with just
	// the pieces packed there; items keep the optional flag of their section so they stay out of the tally.
	bagSections = $derived.by(() => {
		const items = this.categories.flatMap((category) => category.items.map((item) => ({ ...item, optional: Boolean(item.optional || category.optional) })));
		const rowsIn = (bagId) =>
			arrange(
				items
					.map((item) => ({ ...item, pieceIndexes: item.pieceIndexes.filter((index) => item.pieceBagIds[index] === bagId) }))
					.filter((item) => item.pieceIndexes.length),
				this.edits.bagOrder[bagId],
			);
		return this.bags
			.filter((bag) => !bag.parent)
			.map((bag) => ({
				...bag,
				items: rowsIn(bag.id),
				inner: this.bags.filter((child) => child.parent === bag.id).map((child) => ({ ...child, items: rowsIn(child.id), inner: [] })),
			}));
	});

	tally = $derived.by(() => {
		const keys = this.categories.filter((category) => !category.optional).flatMap((category) => category.items.flatMap(rowKeys));
		return { checked: this.countChecked(keys), total: keys.length };
	});

	constructor() {
		store.onSharedChange((name) => {
			if (name === 'edits') this.edits = normalizeEdits(store.read('edits', {}));
			else this.#replaceChecked(store.read('checked', []));
		});
	}

	#change(change) {
		change(this.edits);
		store.write('edits', $state.snapshot(this.edits));
	}

	#saveChecked() {
		store.write('checked', [...this.checked]);
	}

	#replaceChecked(keys) {
		const next = new Set(keys);
		for (const key of this.checked) if (!next.has(key)) this.checked.delete(key);
		for (const key of next) this.checked.add(key);
	}

	countChecked(keys) {
		return keys.filter((key) => this.checked.has(key)).length;
	}

	setChecked(keys, checked) {
		for (const key of keys) {
			if (checked) this.checked.add(key);
			else this.checked.delete(key);
		}
		this.#saveChecked();
	}

	clearChecked() {
		this.checked.clear();
		this.#saveChecked();
	}

	deleteItem(itemId) {
		this.#change((edits) => {
			const addedIndex = edits.added.findIndex((item) => item.id === itemId);
			if (addedIndex >= 0) {
				edits.added.splice(addedIndex, 1);
				delete edits.counts[itemId];
			} else {
				edits.deleted.push(itemId);
			}
		});
	}

	restoreDeleted() {
		this.#change((edits) => {
			edits.deleted = [];
		});
	}

	// New pieces join the item's bag. Ticks on removed pieces are forgotten, or adding a piece back would bring them back.
	changeCount(itemId, change) {
		let count;
		this.#change((edits) => {
			const item = findItem(edits, itemId);
			count = clampCount(item.count + change);
			edits.counts[itemId] = count;
			writePieces(edits, item, Array.from({ length: count }, (_, index) => item.pieceBagIds[index] ?? item.bagId));
		});
		for (const key of this.checked) {
			const [keyItemId, index] = key.split(':');
			if (keyItemId === itemId && Number(index) >= count) this.checked.delete(key);
		}
		this.#saveChecked();
	}

	// A trailing count such as "Ponožky 3x" adds that many pieces.
	addItem(categoryId, text) {
		const [, labelText, countText] = text.trim().match(/^(.*?)(?:\s+(\d+)\s*[x×])?$/i);
		const label = labelText.trim();
		if (!label) return false;
		const count = clampCount(Number(countText ?? 1));
		this.#change((edits) => {
			const category = sectionsOf(edits).find((candidate) => candidate.id === categoryId);
			edits.added.push({ id: newId('vlastni'), categoryId, label, count, emoji: category.emoji, custom: true });
		});
		return true;
	}

	// Each section or bag id with its item ids, in page order.
	listOrder(layout) {
		const blocks = layout === 'bags' ? this.bagSections.flatMap((bag) => [bag, ...bag.inner]) : this.categories;
		return new Map(blocks.map((block) => [block.id, block.items.map((item) => item.id)]));
	}

	// Puts a dragged row into toList before beforeId, or last when beforeId is null. In the bag layout a row carries only
	// the pieces packed in its bag, so those pieces change bag.
	move(layout, { itemId, fromList, toList, beforeId }) {
		const lists = this.listOrder(layout);
		const without = (ids) => ids.filter((id) => id !== itemId);
		const target = without(lists.get(toList));
		const position = beforeId === null ? -1 : target.indexOf(beforeId);
		target.splice(position < 0 ? target.length : position, 0, itemId);
		const itemIdsByList = { [toList]: target, ...(fromList !== toList && { [fromList]: without(lists.get(fromList)) }) };
		this.#change((edits) => {
			for (const [listId, itemIds] of Object.entries(itemIdsByList)) {
				if (layout === 'bags') {
					edits.bagOrder[listId] = itemIds;
					continue;
				}
				edits.order[listId] = itemIds;
				for (const id of itemIds) {
					const added = edits.added.find((item) => item.id === id);
					if (added) added.categoryId = listId;
					else if (homeCategory.get(id) === listId) delete edits.sectionOf[id];
					else edits.sectionOf[id] = listId;
				}
			}
			if (layout !== 'bags' || fromList === toList) return;
			const item = findItem(edits, itemId);
			writePieces(edits, item, item.pieceBagIds.map((bagId) => (bagId === fromList ? toList : bagId)));
		});
	}

	// Up and down step through the row's list and carry on into the neighbouring lists at its ends. Returns the list the
	// row ends up in, or null at the very top or bottom.
	moveByKey(layout, itemId, listId, direction) {
		const lists = [...this.listOrder(layout)];
		const listIndex = lists.findIndex(([id]) => id === listId);
		const ids = lists[listIndex][1];
		const next = ids.indexOf(itemId) + direction;
		if (next >= 0 && next < ids.length) {
			this.move(layout, { itemId, fromList: listId, toList: listId, beforeId: direction < 0 ? ids[next] : (ids[next + 1] ?? null) });
			return listId;
		}
		const neighbour = lists[listIndex + direction];
		if (!neighbour) return null;
		this.move(layout, { itemId, fromList: listId, toList: neighbour[0], beforeId: direction < 0 ? null : (neighbour[1][0] ?? null) });
		return neighbour[0];
	}

	// Without a piece index every piece of the item moves.
	setBag(itemId, bagId, pieceIndex) {
		this.#change((edits) => {
			const item = findItem(edits, itemId);
			writePieces(edits, item, item.pieceBagIds.map((current, index) => (pieceIndex === undefined || index === pieceIndex ? bagId : current)));
		});
	}

	saveSection(sectionId, { title, emoji }) {
		if (!cleanTitle(title)) return false;
		this.#change((edits) => {
			const added = edits.addedSections.find((section) => section.id === sectionId);
			if (added) Object.assign(added, { title: cleanTitle(title), emoji });
			else edits.sections[sectionId] = { title: cleanTitle(title), emoji };
		});
		return true;
	}

	addSection({ title, emoji }) {
		if (!cleanTitle(title)) return false;
		this.#change((edits) => {
			edits.addedSections.push({ id: newId('sekce'), title: cleanTitle(title), emoji });
		});
		return true;
	}

	// Only an empty added section goes, so no item is ever lost with it.
	deleteSection(sectionId) {
		if (!this.categories.find((category) => category.id === sectionId)?.deletable) return;
		this.#change((edits) => {
			edits.addedSections = edits.addedSections.filter((section) => section.id !== sectionId);
			delete edits.order[sectionId];
		});
	}

	// The main bag, and a bag holding inner bags, stay top-level.
	saveBag(bagId, { title, emoji, parent }) {
		if (!cleanTitle(title)) return false;
		this.#change((edits) => {
			const bags = bagsOf(edits);
			const canNest = mainBagId(bags) !== bagId && !bags.some((bag) => bag.parent === bagId) && parent !== bagId;
			edits.bags = bags.map((bag) => (bag.id === bagId ? { id: bag.id, title: cleanTitle(title), emoji, ...(canNest && parent && { parent }) } : bag));
		});
		return true;
	}

	addBag({ title, emoji, parent }) {
		if (!cleanTitle(title)) return false;
		this.#change((edits) => {
			edits.bags = [...bagsOf(edits), { id: newId('zavazadlo'), title: cleanTitle(title), emoji, ...(parent && { parent }) }];
		});
		return true;
	}

	// The main bag stays. Pieces of a deleted bag go to the bag around it, or to the main one; its inner bags become
	// top-level.
	deleteBag(bagId) {
		this.#change((edits) => {
			const bags = bagsOf(edits);
			const bag = bags.find((candidate) => candidate.id === bagId);
			const mainId = mainBagId(bags);
			if (!bag || mainId === bagId) return;
			const fallback = bag.parent ?? mainId;
			for (const item of resolvedItems(edits)) {
				if (item.pieceBagIds.includes(bagId)) writePieces(edits, item, item.pieceBagIds.map((pieceBagId) => (pieceBagId === bagId ? fallback : pieceBagId)));
			}
			edits.bags = bags.filter((candidate) => candidate.id !== bagId).map(({ parent, ...rest }) => (parent && parent !== bagId ? { ...rest, parent } : rest));
			delete edits.bagOrder[bagId];
		});
	}
}

export const list = new PackingList();
