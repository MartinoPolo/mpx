import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolvePiCodingAgentDir } from './lib/agent-directory.js';

type Registration = { file: string; sessionId: string };

const PROCESS_ID = process.pid;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const executeFile = promisify(execFile);
let processStartedAtPromise: Promise<string | undefined> | undefined;
let registered: Registration | undefined;

// Lifecycle events can overlap (a rename landing while the session shuts down),
// and every handler mutates the same `registered` record plus the same files, so
// all of them run one at a time on this queue.
let operationQueue: Promise<void> = Promise.resolve();

function enqueue(operation: () => Promise<void>): Promise<void> {
  operationQueue = operationQueue.then(operation, operation).catch(() => {});
  return operationQueue;
}

async function queryProcessStartedAt(): Promise<string | undefined> {
  const script =
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${PROCESS_ID}')` +
    ".CreationDate.ToUniversalTime().ToString('o')";
  try {
    const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: PROCESS_QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    const startedAt = stdout.trim();
    return Number.isFinite(Date.parse(startedAt)) ? startedAt : undefined;
  } catch {
    return undefined;
  }
}

function processStartedAt(): Promise<string | undefined> {
  processStartedAtPromise ??= queryProcessStartedAt().then((startedAt) => {
    if (!startedAt) {
      processStartedAtPromise = undefined;
    }
    return startedAt;
  });
  return processStartedAtPromise;
}

export function registryRoot(cwd: string): string {
  return join(resolvePiCodingAgentDir(cwd), 'agent-resurrect', 'active-sessions');
}

// The pid suffix keeps two live Pi processes on the same session from
// overwriting (and later deleting) each other's record; the reader dedupes.
function registryFile(root: string, sessionId: string): string {
  const readable =
    sessionId
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 64) || 'session';
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return join(root, `${readable}-${digest}-${PROCESS_ID}.json`);
}

async function removeRegistrationFile(registration: Registration): Promise<void> {
  try {
    const entry = JSON.parse(await readFile(registration.file, 'utf8'));
    if (entry?.pid === PROCESS_ID && entry?.sessionId === registration.sessionId) {
      await unlink(registration.file);
    }
  } catch {
    // Missing/replaced registry entries need no cleanup.
  }
}

async function writeRegistration(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const sessionFileValue = ctx.sessionManager.getSessionFile();
  if (!sessionFileValue) {
    return;
  }
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) {
    return;
  }
  const processStartedAtValue = await processStartedAt();
  if (!processStartedAtValue) {
    return;
  }
  const sessionFile = isAbsolute(sessionFileValue)
    ? sessionFileValue
    : resolve(ctx.cwd, sessionFileValue);
  const file = registryFile(registryRoot(ctx.cwd), sessionId);
  const temp = `${file}.${PROCESS_ID}.${Date.now()}.tmp`;
  const name = pi.getSessionName();
  const entry = {
    version: 2,
    agent: 'pi',
    sessionId,
    sessionFile,
    cwd: ctx.cwd,
    ...(name ? { name } : {}),
    pid: PROCESS_ID,
    processStartedAt: processStartedAtValue,
    registeredAt: new Date().toISOString(),
  };

  const previous = registered;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, JSON.stringify(entry, null, 2) + '\n', 'utf8');
    await rename(temp, file);
    registered = { file, sessionId };
  } catch {
    try {
      await unlink(temp);
    } catch {
      /* temp was never created or already moved */
    }
    return;
  }
  // Only after the new record is durably in place: drop the stale one this
  // process owned, so the session is never briefly absent from the registry.
  if (previous && previous.file !== file) {
    await removeRegistrationFile(previous);
  }
}

async function removeOwnRegistration(): Promise<void> {
  if (!registered) {
    return;
  }
  await removeRegistrationFile(registered);
  registered = undefined;
}

export default function agentResurrect(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => enqueue(() => writeRegistration(pi, ctx)));
  pi.on('session_info_changed', (_event, ctx) => enqueue(() => writeRegistration(pi, ctx)));
  pi.on('session_shutdown', () => enqueue(() => removeOwnRegistration()));
}
