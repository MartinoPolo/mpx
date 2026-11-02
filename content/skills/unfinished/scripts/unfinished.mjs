#!/usr/bin/env node
// Records a session as unfinished in the Obsidian list the morning brief reads, so the session can be closed and
// resumed later with one click (the `agent-launch:resume/<id>` link handler).
// Usage: unfinished.mjs [note on what is left] [--done] [--session <id>] [--title <text>]
// The Claude prompt hook and the Pi `/unfinished` command import recordUnfinished and spend no model tokens.
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const LIST_PATH = join('_Tooling', 'Unfinished sessions.md');
const LIST_HEADER = '# Unfinished sessions\n\nOpen `#unfinished` tasks are listed in the morning brief. Tick a task when the session is done.\n\n';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The newest user-set title, else the harness-generated one, from a Claude transcript. */
export async function claudeSessionTitle(transcriptPath) {
  const transcript = await readFile(transcriptPath, 'utf8').catch(() => '');
  for (const pattern of [/"customTitle":"((?:[^"\\]|\\.)*)"/g, /"aiTitle":"((?:[^"\\]|\\.)*)"/g]) {
    const last = [...transcript.matchAll(pattern)].at(-1);
    if (last) return JSON.parse(`"${last[1]}"`);
  }
  return undefined;
}

/** Adds or refreshes this session's open entry, or ticks it when `done`; returns a one-line result. */
export async function recordUnfinished({ vault, sessionId, cwd, title, note, done = false }) {
  const listFile = join(vault, LIST_PATH);
  const existing = await readFile(listFile, 'utf8').catch(() => LIST_HEADER);
  const lines = existing.split('\n');
  const index = lines.findIndex((line) => /^- \[ \] /.test(line) && line.includes(sessionId));
  if (done) {
    if (index === -1) return 'This session is not on the unfinished list.';
    lines[index] = lines[index].replace('- [ ] ', '- [x] ');
  } else {
    const today = new Date().toLocaleDateString('sv');
    const description = [title, note].filter(Boolean).join(' · ') || 'Unnamed session';
    const task = `- [ ] #unfinished ${description} · ${basename(cwd)} [▶ resume](agent-launch:resume/${sessionId}) ➕ ${today}`;
    if (index === -1) lines.splice(lines.at(-1) === '' ? -1 : lines.length, 0, task);
    else lines[index] = task;
  }
  await mkdir(dirname(listFile), { recursive: true });
  await writeFile(listFile, lines.join('\n'));
  return done ? 'Ticked off the unfinished list.' : `Saved as unfinished: ${title ?? note ?? sessionId}. You can close this session.`;
}

const comparable = (path) => path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

// A Pi transcript starts with a session header line; transcripts grow large, so read only the start.
async function readHeader(path) {
  const handle = await open(path);
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
    return JSON.parse(buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0]);
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

async function newestPiSessionHere(config) {
  let newest;
  for (const account of ['personal', 'work']) {
    const root = join(config.accounts[account].pi, 'sessions');
    for (const folder of await readdir(root).catch(() => [])) {
      for (const file of await readdir(join(root, folder)).catch(() => [])) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(root, folder, file);
        const info = await stat(path);
        if (newest && info.mtime <= newest.modified) continue;
        const header = await readHeader(path);
        if (comparable(header.cwd ?? '') === comparable(process.cwd())) newest = { modified: info.mtime, id: header.id };
      }
    }
  }
  return newest?.id;
}

if (process.argv[1] && comparable(process.argv[1]) === comparable(fileURLToPath(import.meta.url))) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { title: { type: 'string' }, session: { type: 'string' }, done: { type: 'boolean' } },
  });
  const vault = process.env.MPX_OBSIDIAN_VAULT;
  if (!vault || !process.env.APPDATA) {
    console.error('Usage: unfinished.mjs [note] [--done] [--session <id>] [--title <text>] (needs MPX_OBSIDIAN_VAULT and APPDATA)');
    process.exit(1);
  }
  const config = JSON.parse(await readFile(join(process.env.APPDATA, 'mpx', 'config.json'), 'utf8'));
  // The harness may pass its placeholder through unexpanded; treat anything that is not an id as absent.
  const sessionId = SESSION_ID.test(values.session ?? '') ? values.session : await newestPiSessionHere(config);
  if (!sessionId) {
    console.error('Could not identify this session: pass --session <id>.');
    process.exit(1);
  }
  const note = positionals.join(' ').trim() || undefined;
  console.log(await recordUnfinished({ vault, sessionId, cwd: process.cwd(), title: values.title, note, done: values.done }));
}
