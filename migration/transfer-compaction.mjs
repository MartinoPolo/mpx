import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!process.env.MPX_PROJECTS || !path.isAbsolute(process.env.MPX_PROJECTS)) throw new Error('An absolute MPX_PROJECTS is required; no source root is guessed.');

const source = path.join(process.env.MPX_PROJECTS, 'mpx/content/instructions/COMPACT.md');
const original = path.join(process.env.MPX_PROJECTS, 'mpx-claude-code/instructions/COMPACT.md');
const destination = path.join(root, 'content/instructions/shared/COMPACT.md');

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const currentBytes = await fs.readFile(source);
const originalBytes = await fs.readFile(original);
if (await exists(destination)) throw new Error(`Refusing to overwrite existing destination: ${destination}`);

if (await fs.realpath(path.dirname(destination)) !== path.join(await fs.realpath(root), 'content', 'instructions', 'shared')) throw new Error('Canonical instruction directory must not be redirected.');
await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);

const destinationBytes = await fs.readFile(destination);
const currentEqual = destinationBytes.equals(currentBytes);
const originalEqual = destinationBytes.equals(originalBytes);
if (!currentEqual) throw new Error('Post-transfer verification failed: destination differs from current source.');

console.log(JSON.stringify({ destination, equalToCurrentSource: currentEqual, equalToOriginalCounterpart: originalEqual }, null, 2));
