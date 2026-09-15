#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import type { Account, LaunchSpec } from '../src/contracts.js';
import { readUserConfig, resolveProject, selectPacks } from '../src/config.js';
import { createLaunchSpec } from '../src/launch.js';
import { prepareResumeLaunch } from '../src/resume-launch.js';
import { readPiSession } from '../src/resume.js';
import { runBounded } from '../src/safeguards/process.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_QUEUED_RECORDS = 4096;
const MAX_SKILL_HEADER_BYTES = 64 * 1024;
const DEADLINE_MS = 120_000;
const OBSERVATION_PREFIX = 'MPX2_NATIVE_PROBE:';
type Obj = Record<string, unknown>;

export interface RpcTransport {
  send(value: Obj): void;
  next(deadlineMs: number): Promise<Obj>;
  requeue?(records: Obj[]): void;
  stop(): Promise<void>;
}
export interface NativeEvidence {
  account: Account; accountRoot: string; cwd: string; provider: string; model: string;
  thinking: string; sessionFile: string; sessionId: string;
  skills: Array<{ name: string; path: string }>; extensionErrors: string[];
  markerMatched: boolean; observation: Obj;
}

function object(value: unknown): value is Obj { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function comparable(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function inside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function parseArguments(argv: string[]): { account: Account; cwd: string; artifacts: string; live: true; projectOverride?: string } {
  const values = new Map<string, string>();
  let live = false;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--live') { if (live) throw new Error('Duplicate --live flag'); live = true; continue; }
    const value = argv[++index];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || values.has(key)) throw new Error('Usage requires exactly --live --account personal|work --cwd <absolute> --artifacts <absolute>');
    values.set(key, value);
  }
  const account = values.get('--account');
  const cwd = values.get('--cwd');
  const artifacts = values.get('--artifacts');
  const projectOverride = values.get('--project-override');
  if (!live || values.size !== (projectOverride ? 4 : 3) || (account !== 'personal' && account !== 'work') || !cwd || !artifacts || !isAbsolute(cwd) || !isAbsolute(artifacts) || (projectOverride !== undefined && !isAbsolute(projectOverride))) {
    throw new Error('Live acceptance requires exactly --live --account personal|work --cwd <absolute> --artifacts <absolute>');
  }
  return { account, cwd: resolve(cwd), artifacts: resolve(artifacts), live: true, ...(projectOverride ? { projectOverride: resolve(projectOverride) } : {}) };
}

export function sanitizeProbeEnvironment(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; removedProviderOverrides: number } {
  const clean: NodeJS.ProcessEnv = {};
  let removedProviderOverrides = 0;
  const exact = new Set(['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_CODING_AGENT_DIR', 'MPX_PARENT_PANE', 'MPX_SESSION', 'MPX_PANE']);
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    const secretOrProvider = upper.endsWith('_API_KEY') || upper.endsWith('_TOKEN') || upper.endsWith('_BASE_URL') || upper.endsWith('_MODEL') || upper.endsWith('_PROVIDER');
    if (upper.startsWith('ORCA_') || upper.includes('PANE') || exact.has(upper) || secretOrProvider) {
      if (secretOrProvider) removedProviderOverrides++;
      continue;
    }
    clean[key] = value;
  }
  return { env: clean, removedProviderOverrides };
}

function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}
export function rpcSpawnCommand(spec: LaunchSpec): { executable: string; args: string[]; windowsVerbatimArguments: boolean } {
  const needsBash = process.platform === 'win32' && !/\.(exe|com)$/i.test(spec.executable);
  const args = needsBash ? ['--noprofile', '--norc', '-c', 'exec "$@"', 'mpx2-native-probe', spec.executable, ...spec.args] : spec.args;
  return { executable: needsBash ? 'bash' : spec.executable, args: needsBash ? args.map(windowsArgument) : args, windowsVerbatimArguments: needsBash };
}

async function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolveClose => {
    const timer = setTimeout(() => resolveClose(false), timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolveClose(true); });
  });
}
async function stopOwnedTree(child: ChildProcessWithoutNullStreams, env: NodeJS.ProcessEnv): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    if (!await waitForClose(child, 3_000)) throw new Error('Owned Pi process tree did not close after termination');
    return;
  }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:/Windows';
  const system32 = join(systemRoot, 'System32');
  const taskkill = join(system32, 'taskkill.exe');
  const powershell = join(system32, 'WindowsPowerShell/v1.0/powershell.exe');
  const killed = await runBounded(taskkill, ['/PID', String(child.pid), '/T', '/F'], process.cwd(), 4_000, 4096, systemRoot, env);
  let successful = killed.code === 0 && !killed.incomplete;
  if (!successful) {
    const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId); $ids=[Collections.Generic.List[int]]::new(); $ids.Add(${child.pid}); do {$a=$false; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)-and !$ids.Contains([int]$p.ProcessId)){$ids.Add([int]$p.ProcessId);$a=$true}}}while($a); foreach($id in $ids){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}; if(Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue){exit 1}`;
    const fallback = await runBounded(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], process.cwd(), 5_000, 4096, systemRoot, env);
    successful = fallback.code === 0 && !fallback.incomplete;
  }
  if (!successful || !await waitForClose(child, 3_000)) throw new Error('Owned Pi process-tree termination could not be verified');
}

export class NativeRpcTransport implements RpcTransport {
  private queue: Obj[] = [];
  private waiters: Array<{ resolve(value: Obj): void; reject(error: Error): void; timer: NodeJS.Timeout }> = [];
  private failure?: Error;
  private pending = '';
  private bytes = 0;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private stopping?: Promise<void>;
  private stderrTail = '';
  private extensionLoadFailed = false;

  constructor(private child: ChildProcessWithoutNullStreams, private terminate: () => Promise<void> = () => stopOwnedTree(child, process.env)) {
    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.consumeStderr(chunk));
    child.stdin.on('error', error => this.fail(new Error(`Pi RPC stdin failed: ${error.message}`)));
    child.once('error', error => this.fail(new Error(`Unable to launch Pi: ${error.message}`)));
    child.once('close', (code, signal) => this.fail(this.extensionLoadFailed
      ? new Error('Pinned native Pi CLI reported an extension-load failure')
      : new Error(`Pi exited (${code ?? signal ?? 'unknown'})`), false));
  }
  private consumeStderr(chunk: Buffer): void {
    this.countOutput(chunk.length, 'diagnostic');
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4096);
    if (this.stderrTail.includes('Hint: Start without extensions using "pi -ne".')) this.extensionLoadFailed = true;
  }
  private countOutput(length: number, kind: string): void {
    this.bytes += length;
    if (this.bytes > MAX_OUTPUT_BYTES) this.fail(new Error(`Pi ${kind} output exceeded 1 MiB`));
  }
  private consumeStdout(chunk: Buffer): void {
    if (this.failure) return;
    try {
      this.countOutput(chunk.length, 'RPC');
      this.pending += this.decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = this.pending.indexOf('\n')) !== -1) {
        const line = this.pending.slice(0, newline).replace(/\r$/, '');
        this.pending = this.pending.slice(newline + 1);
        if (line !== '') this.push(JSON.parse(line));
      }
    } catch (error) { this.fail(error); }
  }
  private push(value: unknown): void {
    if (!object(value)) { this.fail(new Error('Pi emitted non-object JSON')); return; }
    const waiter = this.waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(value); return; }
    if (this.queue.length >= MAX_QUEUED_RECORDS) { this.fail(new Error('Pi RPC event queue exceeded limit')); return; }
    this.queue.push(value);
  }
  private fail(error: unknown, terminate = true): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(this.failure); }
    if (terminate) void this.ensureStopped().catch(() => undefined);
  }
  private ensureStopped(): Promise<void> { return this.stopping ??= this.terminate(); }
  requeue(records: Obj[]): void {
    if (records.length + this.queue.length > MAX_QUEUED_RECORDS) throw new Error('Pi RPC event queue exceeded limit');
    this.queue.unshift(...records);
  }
  send(value: Obj): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(value)}\n`, error => { if (error) this.fail(new Error(`Pi RPC stdin failed: ${error.message}`)); });
  }
  async next(deadlineMs: number): Promise<Obj> {
    if (this.queue.length) return this.queue.shift()!;
    if (this.failure) throw this.failure;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new Error('Pi RPC stage timed out');
    return new Promise<Obj>((resolveNext, reject) => {
      const waiter = { resolve: resolveNext, reject, timer: setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('Pi RPC stage timed out'));
      }, remaining) };
      this.waiters.push(waiter);
    });
  }
  async stop(): Promise<void> {
    try { await this.ensureStopped(); } catch (cleanup) {
      if (this.failure) throw new AggregateError([this.failure, cleanup], 'Pi execution and cleanup both failed');
      throw cleanup;
    }
  }
}

function response(record: Obj, id: string): Obj | undefined {
  if (record.type !== 'response' || record.id !== id) return undefined;
  if (record.success !== true) throw new Error(`Pi RPC ${id} failed: ${String(record.error ?? 'unknown error')}`);
  return object(record.data) ? record.data : {};
}
function extensionError(record: Obj, errors: string[]): boolean {
  if (record.type !== 'extension_error') return false;
  errors.push(`${String(record.extensionPath ?? 'unknown')}: ${String(record.error ?? 'error')}`);
  return true;
}
export async function request(transport: RpcTransport, command: Obj, deadline: number, errors: string[]): Promise<Obj> {
  const deferred: Obj[] = [];
  transport.send(command);
  try {
    for (;;) {
      const event = await transport.next(deadline);
      if (extensionError(event, errors)) continue;
      const data = response(event, String(command.id));
      if (data) return data;
      deferred.push(event);
    }
  } finally { transport.requeue?.(deferred); }
}
export async function completePrompt(transport: RpcTransport, message: string, deadline: number, errors: string[]): Promise<string> {
  await request(transport, { id: 'prompt', type: 'prompt', message }, deadline, errors);
  let successful = false;
  for (;;) {
    const event = await transport.next(deadline);
    if (extensionError(event, errors)) continue;
    if (event.type === 'tool_execution_start') throw new Error(`Probe attempted tool ${String(event.toolName)}`);
    if (event.type === 'message_end' && object(event.message) && event.message.role === 'assistant') successful = event.message.stopReason === 'stop';
    if (event.type === 'agent_settled') break;
  }
  if (!successful) throw new Error('Assistant did not complete successfully');
  const data = await request(transport, { id: 'last', type: 'get_last_assistant_text' }, deadline, errors);
  if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('Assistant completion contained no text');
  return data.text;
}

async function expectedSkillFiles(paths: string[]): Promise<Map<string, string>> {
  const expected = new Map<string, string>();
  const inspect = async (file: string): Promise<void> => {
    const handle = await open(file, 'r');
    const bytes = Buffer.alloc(MAX_SKILL_HEADER_BYTES);
    let bytesRead: number;
    try { ({ bytesRead } = await handle.read(bytes, 0, bytes.length, 0)); } finally { await handle.close(); }
    const text = bytes.subarray(0, bytesRead).toString('utf8').replace(/\r\n/g, '\n');
    const end = text.startsWith('---\n') ? text.indexOf('\n---', 4) : -1;
    if (end < 0) throw new Error(`Skill has no bounded YAML frontmatter: ${file}`);
    const match = /^name:\s*["']?([^\s"']+)["']?\s*$/m.exec(text.slice(4, end));
    if (!match) throw new Error(`Skill frontmatter has no name: ${file}`);
    if (expected.has(match[1]!)) throw new Error(`Duplicate expected MPX2 skill name: ${match[1]}`);
    expected.set(match[1]!, await realpath(file));
  };
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path);
      else if (entry.isFile() && entry.name === 'SKILL.md') await inspect(path);
    }
  };
  for (const path of paths) await walk(path);
  return expected;
}
export async function validateCommands(data: Obj, expected: Map<string, string>, managedRoots: string[] = []): Promise<Array<{ name: string; path: string }>> {
  if (!Array.isArray(data.commands)) throw new Error('get_commands returned no command list');
  const found = new Map<string, string[]>();
  const expectedPaths = new Set([...expected.values()].map(comparable));
  for (const command of data.commands) {
    if (!object(command) || typeof command.name !== 'string' || !command.name.startsWith('skill:')) continue;
    const name = command.name.slice('skill:'.length);
    const sourcePath = object(command.sourceInfo) && typeof command.sourceInfo.path === 'string' ? command.sourceInfo.path : undefined;
    if (expected.has(name) && (command.source !== 'skill' || sourcePath === undefined)) throw new Error(`Skill command ${command.name} has the wrong source or no path`);
    const actual = sourcePath !== undefined ? await realpath(sourcePath).catch(error => {
      if (expected.has(name)) throw new Error(`Projected skill ${name} source is unavailable`, { cause: error });
      return sourcePath;
    }) : undefined;
    if (expected.has(name)) (found.get(name) ?? (found.set(name, []), found.get(name)!)).push(actual!);
    else if (name.startsWith('mp-') || (actual !== undefined && (managedRoots.some(root => inside(actual, root)) || expectedPaths.has(comparable(actual))))) throw new Error(`Unexpected MPX2 skill command: ${name}`);
  }
  const evidence: Array<{ name: string; path: string }> = [];
  for (const [name, path] of expected) {
    const paths = found.get(name) ?? [];
    if (paths.length !== 1 || comparable(paths[0]!) !== comparable(path)) throw new Error(`Projected skill ${name} resolved ${paths.length} times or from the wrong path: ${paths.slice(0, 3).join(', ')}; expected ${path}`);
    evidence.push({ name, path: paths[0]! });
  }
  return evidence;
}

function parseObservation(event: Obj): Obj | undefined {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify' || typeof event.message !== 'string' || !event.message.startsWith(OBSERVATION_PREFIX)) return undefined;
  const value: unknown = JSON.parse(event.message.slice(OBSERVATION_PREFIX.length));
  if (!object(value)) throw new Error('Probe observer emitted invalid evidence');
  return value;
}
export async function waitForObservation(transport: RpcTransport, deadline: number, errors: string[]): Promise<Obj> {
  for (;;) {
    const event = await transport.next(deadline);
    if (extensionError(event, errors)) continue;
    const observation = parseObservation(event);
    if (observation) return observation;
  }
}
function validateNativeTools(observation: Obj): void {
  if (!Array.isArray(observation.tools) || !observation.tools.every(name => typeof name === 'string')) throw new Error('Native observer returned no registered tool names');
  for (const name of ['Agent', 'get_subagent_result', 'steer_subagent']) if (!observation.tools.includes(name)) throw new Error(`Native tool composition lacked ${name}`);
}
async function spawnRpc(spec: LaunchSpec): Promise<NativeRpcTransport> {
  const command = rpcSpawnCommand(spec);
  const child = spawn(command.executable, command.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  return new NativeRpcTransport(child, () => stopOwnedTree(child, spec.env));
}
async function runStage(spec: LaunchSpec, expected: Map<string, string>, roots: string[], prompt: string, marker: string): Promise<NativeEvidence> {
  const rpc = await spawnRpc(spec);
  const errors: string[] = [];
  const deadline = Date.now() + DEADLINE_MS;
  let primary: unknown;
  try {
    const state = await request(rpc, { id: 'state', type: 'get_state' }, deadline, errors);
    const observation = await waitForObservation(rpc, deadline, errors);
    validateNativeTools(observation);
    const commands = await request(rpc, { id: 'commands', type: 'get_commands' }, deadline, errors);
    const skills = await validateCommands(commands, expected, roots);
    if (errors.length) throw new Error(`Pi reported ${errors.length} extension error(s) before the prompt`);
    const reply = await completePrompt(rpc, prompt, deadline, errors);
    const final = await request(rpc, { id: 'final', type: 'get_state' }, deadline, errors);
    if (errors.length) throw new Error(`Pi reported ${errors.length} extension error(s)`);
    const model = final.model;
    if (!object(model) || typeof model.provider !== 'string' || typeof model.id !== 'string' || typeof final.thinkingLevel !== 'string' || typeof final.sessionFile !== 'string' || typeof final.sessionId !== 'string') throw new Error('get_state lacked native identity evidence');
    if (!object(state.model) || state.model.provider !== model.provider || state.model.id !== model.id || state.thinkingLevel !== final.thinkingLevel) throw new Error('Runtime identity changed during probe');
    const accountRoot = String(observation.accountRoot ?? '');
    const cwd = String(observation.cwd ?? '');
    const sessionFile = String(observation.sessionFile ?? '');
    const sessionId = String(observation.sessionId ?? '');
    if (comparable(accountRoot) !== comparable(spec.env.PI_CODING_AGENT_DIR!) || comparable(cwd) !== comparable(spec.cwd) || comparable(sessionFile) !== comparable(final.sessionFile) || sessionId !== final.sessionId) throw new Error('Native observer disagreed with expected account/cwd/session identity');
    const markerMatched = reply.includes(marker);
    if (!markerMatched) throw new Error('Assistant reply did not contain the required marker');
    return { account: spec.env.MPX_ACCOUNT as Account, accountRoot, cwd, provider: model.provider, model: model.id, thinking: final.thinkingLevel, sessionFile: final.sessionFile, sessionId: final.sessionId, skills, extensionErrors: [], markerMatched, observation };
  } catch (error) { primary = error; throw error; }
  finally {
    try { await rpc.stop(); } catch (cleanup) { if (primary) throw new AggregateError([primary, cleanup], 'Probe execution and cleanup failed'); throw cleanup; }
  }
}

export async function validateArtifactDestination(path: string, protectedPaths: string[], allowedWithin?: { root: string; exactPath: string }): Promise<void> {
  if (await lstat(path).catch(() => undefined)) throw new Error('--artifacts must be a new path owned exclusively by this probe');
  for (const protectedPath of protectedPaths) {
    const explicitlyAllowed = allowedWithin && comparable(protectedPath) === comparable(allowedWithin.root) && comparable(path) === comparable(allowedWithin.exactPath);
    if (!explicitlyAllowed && (inside(path, protectedPath) || inside(protectedPath, path))) throw new Error('--artifacts must be exclusive from project and account resources');
  }
  let cursor = dirname(path);
  while (!(await lstat(cursor).catch(() => undefined))) {
    const parent = dirname(cursor); if (parent === cursor) throw new Error('--artifacts has no existing physical ancestor'); cursor = parent;
  }
  for (;;) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('--artifacts ancestors must be physical directories');
    await realpath(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
export function observerSource(): string {
  return `import { getAgentDir } from "@earendil-works/pi-coding-agent";\nexport default function(pi:any){pi.on("session_start",async(_e:any,ctx:any)=>{ctx.ui.notify(${JSON.stringify(OBSERVATION_PREFIX)}+JSON.stringify({cwd:ctx.cwd,accountRoot:getAgentDir(),sessionFile:ctx.sessionManager.getSessionFile(),sessionId:ctx.sessionManager.getSessionId(),tools:pi.getAllTools().map((tool:any)=>tool.name)}),"info")});pi.on("tool_call",async(e:any)=>({block:true,reason:"Native acceptance probe forbids tool calls: "+e.toolName}));}\n`;
}
async function writeSummary(path: string, summary: Obj): Promise<void> { await writeFile(join(path, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' }); }

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(argv);
  let artifactsCreated = false;
  try {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    if (!(await stat(options.cwd).catch(() => undefined))?.isDirectory()) throw new Error('--cwd is not a directory');
    const project = await resolveProject(options.cwd);
    if (!project.config) throw new Error('--cwd must be a registered MPX2 project');
    if (!process.env.APPDATA) throw new Error('APPDATA is unset');
    const config = await readUserConfig(join(process.env.APPDATA, 'mpx2', 'config.json'));
    const accountRoot = config.accounts[options.account].pi;
    const localArtifact = comparable(dirname(options.artifacts)) === comparable(join(root, '.local'))
      ? { root, exactPath: options.artifacts } : undefined;
    await validateArtifactDestination(options.artifacts, [options.cwd, accountRoot, root], localArtifact);
    const selection = await selectPacks(root, 'pi', options.account, project, config);
    const expected = await expectedSkillFiles(selection.paths);
    const projectOverrides: Array<{ name: string; path: string; selectedPackPath: string }> = [];
    if (options.projectOverride) {
      const overridePath = await realpath(options.projectOverride);
      if (![join(options.cwd, '.agents', 'skills'), join(options.cwd, '.pi', 'skills')].some(directory => inside(overridePath, directory))) throw new Error('Override must be an explicitly selected native project skill');
      const overrideSkills = await expectedSkillFiles([dirname(overridePath)]);
      if (overrideSkills.size !== 1) throw new Error('Project override directory is ambiguous');
      const [name, skillPath] = [...overrideSkills][0]!;
      const selectedPackPath = expected.get(name);
      if (!selectedPackPath || comparable(skillPath) !== comparable(overridePath)) throw new Error('Project override does not match a selected MPX2 skill');
      expected.set(name, skillPath);
      projectOverrides.push({ name, path: skillPath, selectedPackPath });
    }
    await mkdir(options.artifacts);
    artifactsCreated = true;
    await writeFile(join(options.artifacts, '.native-pi-acceptance-owned'), 'owned\n', { flag: 'wx' });
    const extension = join(options.artifacts, 'observer.ts');
    await writeFile(extension, observerSource(), { flag: 'wx' });
    const clean = sanitizeProbeEnvironment(process.env);
    const marker = randomBytes(12).toString('hex');
    const initialSpec = await createLaunchSpec({ root, cwd: options.cwd, harness: 'pi', account: options.account, config, project, selection, args: ['--mode', 'rpc', '--extension', extension], env: clean.env });
    if (initialSpec.requiresConfirmation) throw new Error('Acceptance runner refuses launches requiring confirmation');
    const managedPackRoot = join(root, 'dist', 'packs');
    const first = await runStage(initialSpec, expected, [managedPackRoot], `Reply with this exact marker and nothing else: ${marker}`, marker);
    const read = await readPiSession(first.sessionFile, options.account, first.accountRoot);
    if (read.session.id !== first.sessionId) throw new Error('Fresh transcript identity did not match native state');
    const prepared = await prepareResumeLaunch({ root, config, session: read.session, env: clean.env });
    if (!prepared.verification.verified) throw new Error('Native resume preparation was not verified');
    prepared.spec.args.push('--mode', 'rpc', '--extension', extension);
    const second = await runStage(prepared.spec, expected, [managedPackRoot], 'Reply with the exact marker from the previous turn and nothing else.', marker);
    for (const key of ['accountRoot', 'cwd', 'provider', 'model', 'thinking', 'sessionFile', 'sessionId'] as const) if (String(first[key]) !== String(second[key]) && comparable(String(first[key])) !== comparable(String(second[key]))) throw new Error(`Resume changed ${key}`);
    const summary = { ok: true, projectOverrides, probeStop: 'deliberate process-tree stop after RPC evidence', observerLimitation: 'an explicit probe-only extension observes native runtime identity', removedInheritedOverrides: clean.removedProviderOverrides, launch: first, resume: second };
    await writeSummary(options.artifacts, summary);
    process.stdout.write(`${JSON.stringify({ ok: true, summary: join(options.artifacts, 'summary.json') })}\n`);
  } catch (error) {
    if (artifactsCreated) await writeSummary(options.artifacts, { ok: false, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main().catch(error => {
  process.stderr.write(`native-pi-acceptance: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
