// Three-way merge of the shared list: what this view changed since it last saw the shared copy wins, everything else
// comes from the shared copy, so two devices or a stale tab writing at once keep each other's changes.
const setPaths = new Set(['checked', 'edits.deleted', 'edits.added', 'edits.addedSections']);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = (entry) => (typeof entry === 'string' ? entry : entry.id);

// The store returns fields in its own order, so equality ignores key order.
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (!isPlainObject(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export const same = (first, second) => JSON.stringify(canonical(first)) === JSON.stringify(canonical(second));

// Ticks and lists of deleted or added things are sets: additions and removals from both sides are kept.
function mergeSet(base, local, shared) {
	const baseEntries = new Map((base ?? []).map((entry) => [keyOf(entry), entry]));
	const localEntries = new Map((local ?? []).map((entry) => [keyOf(entry), entry]));
	const result = new Map((shared ?? []).map((entry) => [keyOf(entry), entry]));
	for (const key of baseEntries.keys()) if (!localEntries.has(key)) result.delete(key);
	for (const [key, entry] of localEntries) if (!same(entry, baseEntries.get(key))) result.set(key, entry);
	return [...result.values()];
}

export function mergeShared(base, local, shared, path = '') {
	if (same(local, base)) return shared;
	if (same(shared, base)) return local;
	if (setPaths.has(path)) return mergeSet(base, local, shared);
	if (!isPlainObject(local) || !isPlainObject(shared)) return local;
	const merged = {};
	for (const key of new Set([...Object.keys(local), ...Object.keys(shared), ...Object.keys(isPlainObject(base) ? base : {})])) {
		const value = mergeShared(isPlainObject(base) ? base[key] : undefined, local[key], shared[key], path ? `${path}.${key}` : key);
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}
