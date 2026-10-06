import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

/*
 * Builds the reusable player once into player/dist. The editor worker is inlined as source text and started
 * from a Blob URL, because browsers refuse worker scripts loaded from file:// pages.
 */
const worker = await build({
	entryPoints: ['node_modules/monaco-editor/esm/vs/editor/editor.worker.js'],
	bundle: true,
	format: 'iife',
	minify: true,
	write: false,
});
const workerSource = worker.outputFiles[0].text;

mkdirSync('player/dist', { recursive: true });
await build({
	entryPoints: { player: 'player/src/main.js' },
	bundle: true,
	format: 'iife',
	minify: true,
	outdir: 'player/dist',
	loader: { '.ttf': 'dataurl', '.woff2': 'dataurl' },
	plugins: [
		{
			name: 'editor-worker-source',
			setup(builder) {
				builder.onResolve({ filter: /^editor-worker-source$/ }, () => ({ path: 'editor-worker-source', namespace: 'inline' }));
				builder.onLoad({ filter: /.*/, namespace: 'inline' }, () => ({ contents: workerSource, loader: 'text' }));
			},
		},
	],
	logLevel: 'warning',
});
copyFileSync('player/index.html', 'player/dist/index.html');
console.log('player/dist built');
