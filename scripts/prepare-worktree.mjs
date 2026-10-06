#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const OPTIONAL_DIRECTORIES = ['.vscode', '.cursor', '.local'];
const PORT_SLOT_STEP = 10;
const MAXIMUM_PORT = 65535;
const PORT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const execFileAsync = promisify(execFile);

export function normalizeNativeWindowsPath(value, platform = process.platform) {
  if (platform !== 'win32' || !value) return value;
  return value.replace(/^\/([a-zA-Z])(?:\/(.*))?$/, (_match, drive, rest = '') => `${drive}:/${rest}`);
}

async function canonicalDirectory(value, name) {
  if (!value) throw new Error(`${name} is required`);

  let stats;
  try {
    stats = await lstat(normalizeNativeWindowsPath(value));
  } catch {
    throw new Error(`${name} must be an existing directory`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${name} must be a real directory`);
  }
  return realpath(normalizeNativeWindowsPath(value));
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative === '' || (!outside && !path.isAbsolute(relative));
}

async function copyMissingDirectory(source, destination, sourceStats = undefined) {
  sourceStats ??= await lstat(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) return;

  try {
    await mkdir(destination);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const destinationStats = await lstat(destination);
  if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) return;

  for (const entry of await readdir(source)) {
    const sourceEntry = path.join(source, entry);
    const destinationEntry = path.join(destination, entry);
    const stats = await lstat(sourceEntry);

    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      await copyMissingDirectory(sourceEntry, destinationEntry);
    } else if (stats.isFile()) {
      try {
        await copyFile(sourceEntry, destinationEntry, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  }
}

export async function prepareWorktree(rootPath, worktreePath) {
  const root = await canonicalDirectory(rootPath, 'ORCA_ROOT_PATH');
  const worktree = await canonicalDirectory(worktreePath, 'ORCA_WORKTREE_PATH');

  if (contains(root, worktree) || contains(worktree, root)) {
    throw new Error('Orca root and worktree must be different, non-overlapping directories');
  }

  for (const directory of OPTIONAL_DIRECTORIES) {
    const source = path.join(root, directory);
    let sourceStats;
    try {
      sourceStats = await lstat(source);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    await copyMissingDirectory(source, path.join(worktree, directory), sourceStats);
  }
}

function parsePortNumber(value, label, minimum) {
  const parsed = Number(value);
  if (!/^\d+$/.test(String(value)) || parsed < minimum || parsed > MAXIMUM_PORT) {
    throw new Error(`${label} must be an integer from ${minimum} to ${MAXIMUM_PORT}`);
  }
  return parsed;
}

function parsePortOptions(argv, env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'port-file': { type: 'string' },
      port: { type: 'string', multiple: true },
      'port-offset': { type: 'string' },
    },
    strict: true,
  });
  if (!values.port?.length) {
    if (values['port-file'] !== undefined || values['port-offset'] !== undefined) {
      throw new Error('--port-file and --port-offset require at least one --port NAME=BASE');
    }
    return undefined;
  }

  const file = values['port-file'];
  if (!file) throw new Error('--port requires --port-file');
  const ports = values.port.map((entry) => {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    if (separator < 1 || !PORT_VARIABLE_NAME.test(name)) throw new Error(`--port ${entry} must be NAME=BASE`);
    return { name, base: parsePortNumber(entry.slice(separator + 1), `--port ${name} base`, 1) };
  });
  if (new Set(ports.map((port) => port.name)).size !== ports.length) throw new Error('--port names must be unique');
  const bases = ports.map((port) => port.base);
  if (Math.max(...bases) - Math.min(...bases) >= PORT_SLOT_STEP) {
    throw new Error(`--port bases must be less than ${PORT_SLOT_STEP} apart so slots never overlap`);
  }
  const offset =
    values['port-offset'] !== undefined
      ? parsePortNumber(values['port-offset'], '--port-offset', 0)
      : env.MPX_PORT_OFFSET
        ? parsePortNumber(env.MPX_PORT_OFFSET, 'MPX_PORT_OFFSET', 0)
        : 0;
  return { file, ports, offset };
}

function readVariable(content, name) {
  const match = content.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*['"]?(\\d+)['"]?\\s*$`, 'm'));
  return match ? Number(match[1]) : undefined;
}

async function readDestinationFile(filePath) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stats.isFile()) throw new Error(`${path.basename(filePath)} exists but is not a regular file`);
  return readFile(filePath, 'utf8');
}

async function listWorktrees(worktree) {
  const { stdout } = await execFileAsync('git', ['-C', worktree, 'worktree', 'list', '--porcelain'], {
    timeout: 30_000,
  });
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => normalizeNativeWindowsPath(line.slice('worktree '.length)));
}

// Why: the slot is derived from the sibling worktrees' own port files on every run, so no port
// registry exists to drift. Slot 0 stays with the root checkout and its committed defaults.
export async function assignWorktreePorts(worktreePath, { file, ports, offset }) {
  const worktree = await canonicalDirectory(worktreePath, 'ORCA_WORKTREE_PATH');
  const destination = path.join(worktree, file);
  const existing = await readDestinationFile(destination);
  if (existing !== undefined && ports.some((port) => readVariable(existing, port.name) !== undefined)) {
    return undefined;
  }

  const [primary] = ports;
  const usedSlots = new Set();
  for (const sibling of await listWorktrees(worktree)) {
    const content = await readFile(path.join(sibling, file), 'utf8').catch(() => undefined);
    const value = content === undefined ? undefined : readVariable(content, primary.name);
    if (value === undefined) continue;
    const slot = (value - primary.base - offset) / PORT_SLOT_STEP;
    if (Number.isInteger(slot) && slot >= 1) usedSlots.add(slot);
  }

  let slot = 1;
  while (usedSlots.has(slot)) slot++;
  const values = ports.map((port) => ({
    name: port.name,
    value: parsePortNumber(port.base + offset + slot * PORT_SLOT_STEP, `${port.name} port`, 1),
  }));
  const lines = values.map(({ name, value }) => `${name}=${value}`).join('\n');
  if (existing === undefined) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${lines}\n`, { flag: 'wx' });
  } else {
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    await writeFile(destination, `${existing}${separator}${lines}\n`);
  }
  return { slot, values };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const portOptions = parsePortOptions(process.argv.slice(2), process.env);
    await prepareWorktree(process.env.ORCA_ROOT_PATH, process.env.ORCA_WORKTREE_PATH);
    if (portOptions !== undefined) {
      const assignment = await assignWorktreePorts(process.env.ORCA_WORKTREE_PATH, portOptions);
      console.log(
        assignment === undefined
          ? `prepare-worktree: kept the existing ports in ${portOptions.file}`
          : `prepare-worktree: port slot ${assignment.slot} in ${portOptions.file}: ${assignment.values.map(({ name, value }) => `${name}=${value}`).join(' ')}`,
      );
    }
  } catch (error) {
    console.error(`prepare-worktree: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  }
}
