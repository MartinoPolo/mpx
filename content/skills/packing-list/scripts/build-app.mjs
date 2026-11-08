#!/usr/bin/env node
// Compiles the Svelte app in app/ into template/packing-app.js, the one script the page runs after packing-data.js.
// Run it after changing app/; trips pick the result up with `packing-trip.mjs sync`. Needs the mpx dev dependencies.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { compile, compileModule } from 'svelte/compiler';

const skillDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const warningsOf = (result) => result.warnings.map((warning) => ({ text: `${warning.code}: ${warning.message}` }));

const sveltePlugin = {
	name: 'svelte',
	setup(build) {
		build.onLoad({ filter: /\.svelte$/ }, async ({ path: file }) => {
			const result = compile(await fs.readFile(file, 'utf8'), { filename: file, generate: 'client' });
			return { contents: result.js.code, loader: 'js', warnings: warningsOf(result) };
		});
		build.onLoad({ filter: /\.svelte\.js$/ }, async ({ path: file }) => {
			const result = compileModule(await fs.readFile(file, 'utf8'), { filename: file, generate: 'client' });
			return { contents: result.js.code, loader: 'js', warnings: warningsOf(result) };
		});
	},
};

await esbuild.build({
	entryPoints: [path.join(skillDirectory, 'app', 'main.js')],
	outfile: path.join(skillDirectory, 'template', 'packing-app.js'),
	bundle: true,
	format: 'iife',
	minify: true,
	target: 'es2022',
	conditions: ['svelte', 'browser', 'production'],
	legalComments: 'none',
	plugins: [sveltePlugin],
	logLevel: 'info',
});
