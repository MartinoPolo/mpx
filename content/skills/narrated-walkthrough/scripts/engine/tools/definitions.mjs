import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotOf } from './snapshot.mjs';
import ts from 'typescript';
import { svelte2tsx } from 'svelte2tsx';
import { VERSION as svelteVersion } from 'svelte/compiler';
import { TraceMap, generatedPositionFor, originalPositionFor } from '@jridgewell/trace-mapping';

/*
 * Answers "go to definition", hover and references at build time, the way VS Code's Svelte extension does:
 * each .svelte file is converted to TypeScript with svelte2tsx and queried through the TypeScript language
 * service on a checkout of one revision. The player only looks the answers up.
 */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const shims = ['svelte-shims-v4.d.ts', 'svelte-jsx-v4.d.ts'].map((name) => fileURLToPath(new URL(`../node_modules/svelte2tsx/${name}`, import.meta.url)).replaceAll('\\', '/'));
const toPosix = (fileName) => fileName.replaceAll('\\', '/');

const lineStarts = (text) => {
	const starts = [0];
	for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
	return starts;
};
const positionOf = (starts, offset) => {
	let line = starts.length - 1;
	while (starts[line] > offset) line--;
	return { line: line + 1, column: offset - starts[line] };
};

const createService = (root) => {
	const configPath = path.join(root, 'tsconfig.json');
	const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root);
	const virtual = new Map();
	/* Svelte files are seen by TypeScript as "<name>.svelte.ts", which also lets imports of "X.svelte" resolve. */
	const svelteOf = (fileName) => (fileName.endsWith('.svelte.ts') ? fileName.slice(0, -3) : null);
	const generated = (svelteFileName) => {
		if (!virtual.has(svelteFileName)) {
			const source = readFileSync(svelteFileName, 'utf8').replaceAll('\r\n', '\n');
			const output = svelte2tsx(source, { filename: svelteFileName, isTsFile: true, mode: 'ts', version: svelteVersion, emitOnTemplateError: true });
			virtual.set(svelteFileName, {
				source,
				code: output.code,
				map: new TraceMap(output.map),
				sourceStarts: lineStarts(source),
				codeStarts: lineStarts(output.code),
			});
		}
		return virtual.get(svelteFileName);
	};
	const exists = (fileName) => {
		const svelte = svelteOf(toPosix(fileName));
		return svelte ? ts.sys.fileExists(svelte) : ts.sys.fileExists(fileName);
	};
	const roots = new Set(shims);
	const host = {
		getCompilationSettings: () => ({ ...config.options, noEmit: true }),
		getScriptFileNames: () => [...roots],
		getScriptVersion: () => '1',
		getScriptSnapshot: (fileName) => {
			const svelte = svelteOf(toPosix(fileName));
			if (svelte) return ts.sys.fileExists(svelte) ? ts.ScriptSnapshot.fromString(generated(svelte).code) : undefined;
			return ts.sys.fileExists(fileName) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName)) : undefined;
		},
		getScriptKind: (fileName) => (svelteOf(toPosix(fileName)) ? ts.ScriptKind.TS : ts.getScriptKindFromFileName(fileName)),
		getCurrentDirectory: () => root,
		getDefaultLibFileName: ts.getDefaultLibFilePath,
		fileExists: exists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		resolveModuleNameLiterals: (literals, containingFile) => literals.map(({ text }) => resolve(text, containingFile)),
	};
	const moduleHost = { fileExists: exists, readFile: ts.sys.readFile, directoryExists: ts.sys.directoryExists, realpath: ts.sys.realpath };
	const resolve = (text, containingFile) => {
		const resolution = ts.resolveModuleName(text.endsWith('.svelte') ? `${text}.ts` : text, containingFile, host.getCompilationSettings(), moduleHost);
		return resolution.resolvedModule && svelteOf(toPosix(resolution.resolvedModule.resolvedFileName))
			? { resolvedModule: { ...resolution.resolvedModule, extension: ts.Extension.Ts } }
			: resolution;
	};
	const service = ts.createLanguageService(host, ts.createDocumentRegistry());
	return { service, roots, svelteOf, generated, resolve };
};

/*
 * One revision of the repository. `index` returns, per file, a list of [line, startColumn, endColumn,
 * definition, hover, references] (columns are zero-based; the last three index the shared tables, -1 when
 * absent). Declarations in files that are not navigable keep their hover but cannot be jumped to.
 */
export const openRevision = (repository, revision) => {
	const root = snapshotOf(repository, revision);
	/* Without a TypeScript project there is nothing to navigate; the files still show and highlight. */
	if (!existsSync(path.join(root, 'tsconfig.json'))) {
		return { root, importsOf: () => [], index: () => ({ symbols: {}, targets: [], hovers: [], references: [] }) };
	}
	const { service, roots, svelteOf, generated, resolve } = createService(root);
	const virtualName = (filePath) => `${root}/${filePath}${filePath.endsWith('.svelte') ? '.ts' : ''}`;
	const relative = (fileName) => {
		const posix = svelteOf(toPosix(fileName)) ?? toPosix(fileName);
		return posix.startsWith(`${root}/`) && !posix.includes('/node_modules/') ? posix.slice(root.length + 1) : null;
	};

	/* Converts a TypeScript span in a (possibly generated) file to a source line and column range. */
	const sourceSpan = (fileName, start, length) => {
		const svelte = svelteOf(toPosix(fileName));
		if (!svelte) {
			const text = ts.sys.readFile(fileName).replaceAll('\r\n', '\n');
			const starts = lineStarts(text);
			const position = positionOf(starts, start);
			return { line: position.line, column: position.column, length };
		}
		const { map, codeStarts } = generated(svelte);
		const position = positionOf(codeStarts, start);
		const original = originalPositionFor(map, { line: position.line, column: position.column });
		return original.line ? { line: original.line, column: original.column, length } : { line: 1, column: 0, length: 0 };
	};
	/* Markup text has no mapping of its own and would land on a neighbouring segment, so the name must match. */
	const generatedOffset = (filePath, line, column, name) => {
		const { map, code, codeStarts } = generated(`${root}/${filePath}`);
		const position = generatedPositionFor(map, { source: `${root}/${filePath}`, line, column });
		const offset = position.line ? codeStarts[position.line - 1] + position.column : -1;
		return code.slice(offset, offset + name.length) === name ? offset : -1;
	};

	/* Repository files that the given files import, for adding them to the review as read-only context. */
	const importsOf = (files) => {
		const found = new Set();
		for (const filePath of files.filter((item) => existsSync(`${root}/${item}`))) {
			const fileName = virtualName(filePath);
			const code = filePath.endsWith('.svelte') ? generated(`${root}/${filePath}`).code : readFileSync(fileName, 'utf8');
			for (const { fileName: specifier } of ts.preProcessFile(code, true, true).importedFiles) {
				const imported = relative(resolve(specifier, fileName).resolvedModule?.resolvedFileName ?? '');
				if (imported && !files.includes(imported)) found.add(imported);
			}
		}
		return [...found];
	};

	const index = (files, isNavigable) => {
		for (const filePath of files) roots.add(virtualName(filePath));
		const targets = [];
		const targetIndexes = new Map();
		const hovers = [];
		const hoverIndexes = new Map();
		const referenceLists = [];
		const referenceIndexes = new Map();
		const intern = (list, indexes, value) => {
			const key = JSON.stringify(value);
			if (!indexes.has(key)) {
				indexes.set(key, list.length);
				list.push(value);
			}
			return indexes.get(key);
		};
		const symbolsByFile = {};
		for (const filePath of files) {
			const fileName = virtualName(filePath);
			const text = readFileSync(`${root}/${filePath}`, 'utf8').replaceAll('\r\n', '\n');
			const starts = lineStarts(text);
			const symbols = [];
			text.split('\n').forEach((lineText, lineIndex) => {
				for (const match of lineText.matchAll(IDENTIFIER)) {
					const column = match.index;
					const offset = filePath.endsWith('.svelte') ? generatedOffset(filePath, lineIndex + 1, column, match[0]) : starts[lineIndex] + column;
					if (offset < 0) continue;
					const definition = service.getDefinitionAndBoundSpan(fileName, offset);
					const info = service.getQuickInfoAtPosition(fileName, offset);
					let definitionIndex = -1;
					let hoverIndex = -1;
					let referencesIndex = -1;
					const declaration = definition?.definitions?.find((item) => relative(item.fileName)) ?? definition?.definitions?.[0];
					const declarationFile = declaration && relative(declaration.fileName);
					if (declarationFile && isNavigable(declarationFile)) {
						const span = sourceSpan(declaration.fileName, declaration.textSpan.start, declaration.textSpan.length);
						definitionIndex = intern(targets, targetIndexes, { file: declarationFile, ...span });
					}
					if (info) {
						const signature = ts.displayPartsToString(info.displayParts).replace(/\s*\$\$\w+/g, '');
						const documentation = ts.displayPartsToString(info.documentation ?? []);
						const where = declaration && !declarationFile ? toPosix(declaration.fileName).replace(/^.*\/node_modules\//, '').replace(/^.*\/typescript\/lib\//, 'typescript/lib/') : '';
						if (signature.trim()) hoverIndex = intern(hovers, hoverIndexes, [signature, documentation, where]);
					}
					if (definitionIndex >= 0) {
						const references = (service.getReferencesAtPosition(fileName, offset) ?? [])
							.map((reference) => ({ file: relative(reference.fileName), reference }))
							.filter(({ file }) => file && isNavigable(file))
							.map(({ file, reference }) => ({ file, ...sourceSpan(reference.fileName, reference.textSpan.start, reference.textSpan.length) }))
							.filter((reference) => reference.length > 0);
						if (references.length > 1) referencesIndex = intern(referenceLists, referenceIndexes, references.map((reference) => intern(targets, targetIndexes, reference)));
					}
					if (definitionIndex >= 0 || hoverIndex >= 0) symbols.push([lineIndex + 1, column, column + match[0].length, definitionIndex, hoverIndex, referencesIndex]);
				}
			});
			symbolsByFile[filePath] = symbols;
		}
		return { symbols: symbolsByFile, targets, hovers, references: referenceLists };
	};

	return { root, importsOf, index };
};
