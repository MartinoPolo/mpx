const ADDED = 1;
const REMOVED = 2;

/*
 * Serves go to definition, peek, hover and references from the index built by tools/definitions.mjs.
 * Symbols are recorded per revision ("base", "head") in file line numbers; this maps them onto whichever
 * model shows them: a unified row is the base revision when removed and the head revision otherwise.
 */
export const registerDefinitions = ({ monaco, review, modelsOf, describeModel, open }) => {
	const symbolLines = { base: new Map(), head: new Map() };
	const symbolsOn = (side, filePath, line) => {
		if (!symbolLines[side].has(filePath)) {
			const byLine = new Map();
			for (const symbol of review.definitions[side].symbols[filePath] ?? []) {
				if (!byLine.has(symbol[0])) byLine.set(symbol[0], []);
				byLine.get(symbol[0]).push(symbol);
			}
			symbolLines[side].set(filePath, byLine);
		}
		return symbolLines[side].get(filePath).get(line) ?? [];
	};

	const symbolAt = (model, position) => {
		const described = describeModel(model);
		if (!described) return null;
		const { filePath, view } = described;
		const file = review.files[filePath];
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
		const symbol = symbolsOn(side, filePath, line).find(([, start, end]) => column >= start && column <= end);
		return symbol ? { side, view, symbol, range: new monaco.Range(position.lineNumber, symbol[1] + 1, position.lineNumber, symbol[2] + 1) } : null;
	};

	const locationOf = (side, target, view) => {
		const file = review.files[target.file];
		const models = modelsOf(target.file);
		const split = view !== 'unified' && models.original;
		const line = split
			? target.line
			: file.rows.findIndex(([kind, oldNumber, newNumber]) => (side === 'base' ? kind !== ADDED && oldNumber === target.line : kind !== REMOVED && newNumber === target.line)) + 1;
		if (line < 1) return null;
		const model = split ? (side === 'base' ? models.original : models.modified) : models.unified;
		const end = target.column + 1 + target.length;
		return { uri: model.uri, range: new monaco.Range(line, target.column + 1, line, end <= model.getLineMaxColumn(line) ? end : target.column + 1) };
	};

	monaco.languages.registerDefinitionProvider('*', {
		provideDefinition: (model, position) => {
			const found = symbolAt(model, position);
			if (!found || found.symbol[3] < 0) return null;
			const location = locationOf(found.side, review.definitions[found.side].targets[found.symbol[3]], found.view);
			return location ? [{ ...location, originSelectionRange: found.range }] : null;
		},
	});
	monaco.languages.registerReferenceProvider('*', {
		provideReferences: (model, position) => {
			const found = symbolAt(model, position);
			if (!found || found.symbol[5] < 0) return null;
			const { references, targets } = review.definitions[found.side];
			return references[found.symbol[5]].map((index) => locationOf(found.side, targets[index], found.view)).filter(Boolean);
		},
	});
	monaco.languages.registerHoverProvider('*', {
		provideHover: (model, position) => {
			const found = symbolAt(model, position);
			if (!found || found.symbol[4] < 0) return null;
			const [signature, documentation, where] = review.definitions[found.side].hovers[found.symbol[4]];
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
