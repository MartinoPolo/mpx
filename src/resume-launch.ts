import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, win32 } from 'node:path';
import { TextDecoder } from 'node:util';
import type { LaunchSpec, UserConfig } from './contracts.js';
import { resolveProject, selectPacks } from './config.js';
import { createLaunchSpec } from './launch.js';
import { planResume, type NativeSession, type ResumeOverrides, type ResumePlan } from './resume.js';

const MAX_PREFLIGHT_OUTPUT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_FINGERPRINT_BYTES = 128 * 1024 * 1024;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 20_000;

export interface ResumeStartupVerification {
  verified: boolean;
  method: 'pi-rpc-read-only-preflight' | 'unsupported';
  observed?: {
    provider: string;
    model: string;
    thinking: string;
    availableThinking: string[];
  };
  reason?: string;
}

export interface PreparedResumeLaunch {
  plan: ResumePlan;
  spec: LaunchSpec;
  verification: ResumeStartupVerification;
}

export interface PrepareResumeLaunchOptions {
  root: string;
  session: NativeSession;
  config: UserConfig;
  overrides?: ResumeOverrides;
  env?: NodeJS.ProcessEnv;
  preflightTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function comparablePath(value: string): string {
  if (win32.isAbsolute(value)) return win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  const normalized = resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function assertExactAccountRoot(session: NativeSession, config: UserConfig): Promise<void> {
  const configured = config.accounts[session.account][session.harness];
  let selectedReal: string;
  let sessionReal: string;
  try {
    [selectedReal, sessionReal] = await Promise.all([realpath(configured), realpath(session.accountRoot)]);
  } catch (error) {
    throw new Error(`Resume account resource is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (comparablePath(selectedReal) !== comparablePath(sessionReal)) {
    throw new Error(`Resume account mismatch: selected ${session.account} ${session.harness} root ${configured} does not match transcript root ${session.accountRoot}`);
  }
}

async function fingerprint(file: string): Promise<string> {
  return new Promise((accept, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    let bytes = 0;
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_TRANSCRIPT_FINGERPRINT_BYTES) {
        stream.destroy(new Error(`Resume transcript exceeds the ${MAX_TRANSCRIPT_FINGERPRINT_BYTES}-byte fingerprint limit`));
      } else hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => accept(hash.digest('hex')));
  });
}

function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function spawnNative(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const needsBash = process.platform === 'win32' && !/\.(exe|com)$/i.test(executable);
  const command = needsBash ? 'bash' : executable;
  const commandArgs = needsBash
    ? ['--noprofile', '--norc', '-c', 'exec "$@"', 'mpx2-resume-preflight', executable, ...args]
    : args;
  return spawn(command, needsBash ? commandArgs.map(windowsArgument) : commandArgs, {
    cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: needsBash,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function stopOwnedProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { try { killer.kill('SIGKILL'); } catch {} done(); }, 2_000);
      killer.once('close', () => { clearTimeout(timer); done(); });
      killer.once('error', () => { clearTimeout(timer); done(); });
    });
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

function responseData(records: JsonObject[], id: string): JsonObject {
  const response = records.find(record => record.type === 'response' && record.id === id);
  if (!response) throw new Error(`Pi resume preflight returned no ${id} response`);
  if (response.success !== true || !object(response.data)) {
    throw new Error(`Pi resume preflight ${id} failed${typeof response.error === 'string' ? `: ${response.error}` : ''}`);
  }
  return response.data;
}

/**
 * Start the selected native Pi runtime in ephemeral RPC mode and inspect its
 * resolved model/effort state. No prompt is sent and no session is opened.
 */
export async function verifyPiResumePreflight(
  spec: LaunchSpec,
  plan: ResumePlan,
  timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
): Promise<ResumeStartupVerification> {
  if (plan.harness !== 'pi' || !plan.fields.provider) throw new Error('Pi resume preflight requires a complete Pi resume plan');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('Pi resume preflight timeout must be between 100 and 120000 milliseconds');
  const sessionFlag = plan.args.indexOf('--session');
  const sessionFile = sessionFlag === -1 ? undefined : plan.args[sessionFlag + 1];
  if (!sessionFile || !isAbsolute(sessionFile)) throw new Error('Pi resume preflight requires an absolute native session file');
  const before = await fingerprint(sessionFile);
  const args = [
    '--provider', plan.fields.provider.value, '--model', plan.fields.model.value,
    '--thinking', plan.fields.thinking.value, '--mode', 'rpc', '--no-session',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-context-files', '--no-tools', '--offline',
  ];
  const env = { ...spec.env, PI_OFFLINE: '1' };
  const child = spawnNative(spec.executable, args, plan.cwd, env);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const records: JsonObject[] = [];
  let pending = '';
  let outputBytes = 0;
  let stderr = '';
  let settled = false;

  const result = await new Promise<{ records: JsonObject[]; stderr: string }>((accept, reject) => {
    const fail = async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await stopOwnedProcess(child).catch(() => undefined);
      reject(error);
    };
    const parseLine = (line: string) => {
      if (line.trim() === '') return;
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { void fail(new Error('Pi resume preflight emitted malformed JSON')); return; }
      if (!object(value)) { void fail(new Error('Pi resume preflight emitted a non-object record')); return; }
      records.push(value);
      if (value.type === 'response' && ['resume-state', 'resume-levels', 'resume-models'].includes(String(value.id)) && value.success !== true) {
        void fail(new Error(`Pi resume preflight ${String(value.id)} failed${typeof value.error === 'string' ? `: ${value.error}` : ''}`));
        return;
      }
      const hasState = records.some(record => record.type === 'response' && record.id === 'resume-state');
      const hasLevels = records.some(record => record.type === 'response' && record.id === 'resume-levels');
      const hasModels = records.some(record => record.type === 'response' && record.id === 'resume-models');
      if (hasState && hasLevels && hasModels && !settled) {
        settled = true;
        clearTimeout(timer);
        void stopOwnedProcess(child).finally(() => accept({ records, stderr }));
      }
    };
    const timer = setTimeout(() => { void fail(new Error(`Pi resume preflight timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.once('error', error => { void fail(new Error(`Unable to start Pi resume preflight: ${error.message}`)); });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PREFLIGHT_OUTPUT_BYTES) { void fail(new Error('Pi resume preflight output exceeded the inspection limit')); return; }
      try { pending += decoder.decode(chunk, { stream: true }); }
      catch { void fail(new Error('Pi resume preflight emitted invalid UTF-8')); return; }
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        parseLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < 16 * 1024) stderr += chunk.toString('utf8').slice(0, 16 * 1024 - Buffer.byteLength(stderr));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      try {
        pending += decoder.decode();
        if (pending !== '') parseLine(pending.replace(/\r$/, ''));
      } catch { void fail(new Error('Pi resume preflight emitted invalid UTF-8')); return; }
      if (!settled) void fail(new Error(`Pi resume preflight exited before verification (${code ?? signal ?? 'unknown'}): ${stderr.trim()}`));
    });
    child.stdin.end(`${JSON.stringify({ id: 'resume-state', type: 'get_state' })}\n${JSON.stringify({ id: 'resume-levels', type: 'get_available_thinking_levels' })}\n${JSON.stringify({ id: 'resume-models', type: 'get_available_models' })}\n`);
  });

  const after = await fingerprint(sessionFile);
  if (after !== before) throw new Error(`Pi transcript changed during read-only resume preflight: ${sessionFile}`);
  const state = responseData(result.records, 'resume-state');
  const levels = responseData(result.records, 'resume-levels');
  const models = responseData(result.records, 'resume-models');
  const model = state.model;
  if (!object(model) || typeof model.provider !== 'string' || typeof model.id !== 'string') {
    throw new Error('Pi resume preflight resolved no model');
  }
  const availableThinking = Array.isArray(levels.levels) && levels.levels.every(level => typeof level === 'string')
    ? levels.levels as string[] : [];
  const modelAvailable = Array.isArray(models.models) && models.models.some(candidate => object(candidate)
    && candidate.provider === plan.fields.provider!.value && candidate.id === plan.fields.model.value);
  const mismatches: string[] = [];
  if (!modelAvailable) mismatches.push('model is not in the native available-model set');
  if (model.provider !== plan.fields.provider.value) mismatches.push(`provider ${model.provider}`);
  if (model.id !== plan.fields.model.value) mismatches.push(`model ${model.id}`);
  if (state.thinkingLevel !== plan.fields.thinking.value) mismatches.push(`effort ${String(state.thinkingLevel)}`);
  if (!availableThinking.includes(plan.fields.thinking.value)) mismatches.push(`available effort levels ${availableThinking.join(',') || '(none)'}`);
  if (mismatches.length > 0) {
    throw new Error(`Pi resume preflight refused silent fallback/clamping; expected ${plan.fields.provider.value}/${plan.fields.model.value}/${plan.fields.thinking.value}, observed ${mismatches.join('; ')}`);
  }
  return {
    verified: true,
    method: 'pi-rpc-read-only-preflight',
    observed: {
      provider: model.provider, model: model.id,
      thinking: state.thinkingLevel as string, availableThinking,
    },
  };
}

/** Prepare the parent picker's managed launch without launching an interactive session. */
export async function prepareResumeLaunch(options: PrepareResumeLaunchOptions): Promise<PreparedResumeLaunch> {
  await assertExactAccountRoot(options.session, options.config);
  const plan = await planResume(options.session, options.overrides);
  const project = await resolveProject(plan.cwd);
  const selection = await selectPacks(options.root, plan.harness, plan.account, project, options.config);
  const spec = await createLaunchSpec({
    root: options.root, cwd: plan.cwd, harness: plan.harness, account: plan.account,
    config: options.config, project, selection, args: plan.args, env: options.env,
  });
  if (plan.harness === 'pi') {
    const verification = await verifyPiResumePreflight(spec, plan, options.preflightTimeoutMs);
    return { plan, spec, verification };
  }
  return {
    plan, spec,
    verification: {
      verified: false,
      method: 'unsupported',
      reason: 'Claude 2.1.236 has no demonstrated read-only startup-state interface; explicit --resume/--model/--effort arguments are prepared but are not proof of restored startup state.',
    },
  };
}
