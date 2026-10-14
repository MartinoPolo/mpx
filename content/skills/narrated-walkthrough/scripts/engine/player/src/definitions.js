const ADDED = 1;
const REMOVED = 2;

/*
 * Serves go to definition, peek, hover and references from the index built by tools/definitions.mjs.
 * Symbols are recorded per round and revision ("base", "head") in file line numbers; this maps them onto whichever
 * model shows them: a unified row is the base revision when removed and the head revision otherwise.
 */
export const registerDefinitions = ({ monaco, review, modelsOf, describeModel, open }) => {
	const symbolLines = new Map();
	const symbolsOn = (round, side, filePath, line) => {
		const key = `${round}:${side}:${filePath}`;
		if (!symbolLines.has(key)) {
			const byLine = new Map();
			for (const symbol of review.rounds[round].definitions[side].symbols[filePath] ?? []) {
				if (!byLine.has(symbol[0])) byLine.set(symbol[0], []);
				byLine.get(symbol[0]).push(symbol);
			}
			symbolLines.set(key, byLine);
		}
		return symbolLines.get(key).get(line) ?? [];
	};

	const symbolAt = (model, position) => {
		const described = describeModel(model);
		if (!described) return null;
		const { filePath, round, view } = described;
		const file = review.rounds[round].files[filePath];
		let side = view === 'original' ? 'base' : 'head';
		let line = position.lineNumber;
		if (view === 'unified') {
			const row = file.rows[position.lineNumber - 1];
			if (!row) return null;
			side = row[0] === REMOVED ? 'base' : 'head';
			line = row[0] === REMOVED ? row[1] : row[2];
		}
		if (file.status === 'unchanged') side = 'head';
		const column = position.column - 1;
		const symbol = symbolsOn(round, side, filePath, line).find(([, start, end]) => column >= start && column <= end);
		return symbol ? { round, side, view, symbol, range: new monaco.Range(position.lineNumber, symbol[1] + 1, position.lineNumber, symbol[2] + 1) } : null;
	};

	const locationOf = ({ round, side, view }, target) => {
		const file = review.rounds[round].files[target.file];
		const models = modelsOf(target.file, round);
		const split = view !== 'unified' && models.original;
		const line = split
			? target.line
			: file.rows.findIndex(([kind, oldNumber, newNumber]) => (side === 'base' ? kind !== ADDED && oldNumber === target.line : kind !== REMOVED && newNumber === target.line)) + 1;
		if (line < 1) return null;
		const model = split ? (side === 'base' ? models.original : models.modified) : models.unified;
		const end = target.column + 1 + target.length;
		return { uri: model.uri, range: new monaco.Range(line, target.column + 1, line, end <= model.getLineMaxColumn(line) ? end : target.column + 1) };
	};
	const definitionsOf = (found) => review.rounds[found.round].definitions[found.side];

	monaco.languages.registerDefinitionProvider('*', {
		provideDefinition: (model, position) => {
			const found = symbolAt(model, position);
			if (!found || found.symbol[3] < 0) return null;
			const location = locationOf(found, definitionsOf(found).targets[found.symbol[3]]);
			return location ? [{ ...location, originSelectionRange: found.range }] : null;
		},
	});
	monaco.languages.registerReferenceProvider('*', {
		provideReferences: (model, position) => {
			const found = symbolAt(model, position);
			if (!found || found.symbol[5] < 0) return null;
			const { references, targets } = definitionsOf(found);
			return references[found.symbol[5]].map((index) => locationOf(found, targets[index])).filter(Boolean);
		},
	});
	monaco.languages.registerHoverProvider('*', {
		provideHover: (model, position) => {
			const found = symbolAt(model, position);
			if (!found || found.symbol[4] < 0) return null;
			const [signature, documentation, where] = definitionsOf(found).hovers[found.symbol[4]];
			const contents = [{ value: `\`\`\`typescript\n${signature}\n\`\`\`` }];
			if (documentation) contents.push({ value: documentation });
			if (where) contents.push({ value: `Declared in \`${where}\`` });
			return { range: found.range, contents };
		},
	});
	/* Monaco only navigates within one model by itself; jumps to another file are handed to the player. */
	monaco.editor.registerEditorOpener({
		openCodeEditor: (source, resource, selectionOrPosition) =>
			source.getModel()?.uri.toString() === resource.toString() ? false : open(source, resource, selectionOrPosition),
	});
};
