/*
 * A walkthrough covers its change in rounds. The first runs from review.base to review.head; each entry of
 * review.updates appends a round from the previous round's head (or its own base, after a rebase) to its own head,
 * with its own chapters, demo and captures. Scenes name their round with "round"; without it they belong to the first.
 */
export const roundsOf = (script) => {
	const { base, head, updates = [] } = script.review;
	const rounds = [{ base, head, title: script.title, subtitle: script.subtitle, demo: script.demo, capture: script.capture }];
	for (const update of updates) {
		/* An update inherits how the bundle is built and brings its own recipe, scenes and sides. */
		const demo = update.demo && { ...script.demo, ...update.demo };
		rounds.push({ base: update.base ?? rounds.at(-1).head, head: update.head, title: update.title, subtitle: update.subtitle, demo, capture: update.capture });
	}
	return rounds;
};

export const roundOfScene = (scene) => scene.round ?? 0;

/* Tools take the round as --round=<index>; the remaining arguments are their own. */
export const parseRoundArgument = (argumentsList) => {
	const flag = argumentsList.find((argument) => argument.startsWith('--round='));
	return { round: flag ? Number(flag.slice('--round='.length)) : 0, rest: argumentsList.filter((argument) => argument !== flag) };
};

export const demoDirectoryOf = (round) => (round === 0 ? 'cache/demo' : `cache/demo-${round}`);

const defaultSides = {
	before: { title: 'Before the change', revision: 'base' },
	after: { title: 'After the change', revision: 'head' },
};
/*
 * Demo and capture sides are columns named by the state of the work they run: "base" before the work started,
 * "reviewed" where this round starts, "head" where it ends. A side given as a string only retitles a default side.
 */
export const sidesOf = (script, round, configured = {}) => {
	const states = { base: script.review.base, reviewed: round.base, head: round.head };
	/* Columns follow the configured order; a default side not configured keeps its place after them. */
	const ids = [...new Set([...Object.keys(configured), ...Object.keys(defaultSides)])];
	const sideOf = (id) => {
		const side = configured[id];
		return side === undefined ? defaultSides[id] : typeof side === 'string' ? { ...defaultSides[id], title: side } : side;
	};
	return Object.fromEntries(
		ids.map((id) => {
			const side = sideOf(id);
			const revision = states[side.revision] ?? side.revision;
			if (!revision) throw new Error(`side "${id}" has no revision`);
			return [id, { title: side.title ?? id, revision }];
		}),
	);
};
