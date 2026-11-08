#!/usr/bin/env node
// Keeps a trip folder in step with the skill template and reuses product photos from earlier trips.
//   sync <trip-dir>    copy the template code and fonts in; never touches packing-data.js, images/ or dist/
//   photos <trip-dir>  copy images/<id>.webp for items without a photo from sibling trip folders, then list the rest
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const templateDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template');
const [command, tripArgument] = process.argv.slice(2);

function fail(message) {
	console.error(message);
	process.exit(1);
}

if (!['sync', 'photos'].includes(command) || !tripArgument) fail('Usage: packing-trip.mjs sync|photos <trip-dir>');
const tripDirectory = path.resolve(tripArgument);

function sync() {
	fs.mkdirSync(path.join(tripDirectory, 'images'), { recursive: true });
	fs.cpSync(templateDirectory, tripDirectory, { recursive: true });
	console.log(`Template copied into ${tripDirectory}`);
	if (!fs.existsSync(path.join(tripDirectory, 'packing-data.js'))) console.log('packing-data.js is still missing.');
}

function readItems() {
	const dataFile = path.join(tripDirectory, 'packing-data.js');
	if (!fs.existsSync(dataFile)) fail(`${dataFile} does not exist.`);
	const sandbox = { window: {} };
	vm.runInNewContext(fs.readFileSync(dataFile, 'utf8'), sandbox);
	return sandbox.window.PACKING_TRIP.categories.flatMap((category) => category.items);
}

function photos() {
	const imagesDirectory = path.join(tripDirectory, 'images');
	fs.mkdirSync(imagesDirectory, { recursive: true });
	const libraryDirectories = fs
		.readdirSync(path.dirname(tripDirectory), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && path.join(path.dirname(tripDirectory), entry.name) !== tripDirectory)
		.map((entry) => path.join(path.dirname(tripDirectory), entry.name, 'images'))
		.filter((directory) => fs.existsSync(directory));

	const reused = [];
	const missing = [];
	for (const item of readItems()) {
		const target = path.join(imagesDirectory, `${item.id}.webp`);
		if (fs.existsSync(target)) continue;
		const found = libraryDirectories.map((directory) => path.join(directory, `${item.id}.webp`)).find((file) => fs.existsSync(file));
		if (found) {
			fs.copyFileSync(found, target);
			reused.push(item.id);
		} else {
			missing.push(`${item.id} (${item.label})`);
		}
	}
	console.log(`Reused from earlier trips: ${reused.length ? reused.join(', ') : 'none'}`);
	console.log(`Still without a photo: ${missing.length ? missing.join(', ') : 'none'}`);
}

if (command === 'sync') sync();
else photos();
