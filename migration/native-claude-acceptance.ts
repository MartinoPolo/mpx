#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Account, LaunchSpec } from '../src/contracts.js';
import { readUserConfig, resolveProject, selectPacks } from '../src/config.js';
import { createLaunchSpec } from '../src/launch.js';
import { runBounded, type ProcessResult } from '../src/safeguards/process.js';

type JsonObject = Record<string, unknown>;
export type CommandRunner = (spec: LaunchSpec, args: string[], timeout: number, maxBytes: number) => Promise<ProcessResult>;
export interface ExpectedSkill { name: string; path: string; explicitOnly: boolean }
export interface StreamMeta {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  permissionMode: string | null;
  skills: string[];
  slashCommands: string[];
  responseText: string;
  successfulResult: boolean;
  effort: string | null;
}

const OUTPUT_LIMIT = 512 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_SKILL_BYTES = 256 * 1024;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isInside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function parseArguments(argv: string[]): { account: Account; cwd: string; artifacts: string; executable?: string } {
  const values = new Map<string, string>();
  let live = false;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!;
    if (key === '--live') {
      if (live) throw new Error('duplicate --live');
      live = true;
      continue;
    }
    if (!['--account', '--cwd', '--artifacts', '--executable'].includes(key) || values.has(key)) {
      throw new Error(`unsupported or duplicate argument: ${key}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    values.set(key, value);
  }
  const account = values.get('--account');
  const cwd = values.get('--cwd');
  const artifacts = values.get('--artifacts');
  const executable = values.get('--executable');
  if (!live || (account !== 'personal' && account !== 'work') || !cwd || !artifacts || !isAbsolute(cwd) || !isAbsolute(artifacts) || (executable !== undefined && !isAbsolute(executable))) {
    throw new Error('Live acceptance requires --live --account personal|work --cwd <absolute> --artifacts <absolute> [--executable <absolute>]');
  }
  return { account, cwd: resolve(cwd), artifacts: resolve(artifacts), ...(executable ? { executable: resolve(executable) } : {}) };
}

export function sanitizeProbeEnvironment(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; removed: string[] } {
  const clean: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('ORCA_') || upper.startsWith('ANTHROPIC_') || upper === 'CLAUDE_CONFIG_DIR' || upper.endsWith('_API_KEY') || upper.endsWith('_TOKEN')) {
      removed.push(upper);
    } else {
      clean[key] = value;
    }
  }
  return { env: clean, removed: [...new Set(removed)].sort() };
}

function catalogNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(entry => typeof entry === 'string' ? entry : isObject(entry) && typeof entry.name === 'string' ? entry.name : '').filter(Boolean);
}
function assistantText(record: JsonObject): string {
  if (!isObject(record.message) || !Array.isArray(record.message.content)) return '';
  return record.message.content
    .filter(isObject)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n');
}

export function parseStream(stdout: string): StreamMeta {
  const records = stdout.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line) as unknown]; } catch { return []; }
  }).filter(isObject);
  const init = records.find(record => record.type === 'system' && record.subtype === 'init');
  const final = records.findLast(record => record.type === 'result');
  const resultText = final && typeof final.result === 'string' ? final.result : '';
  return {
    sessionId: typeof init?.session_id === 'string' ? init.session_id : null,
    cwd: typeof init?.cwd === 'string' ? resolve(init.cwd) : null,
    model: typeof init?.model === 'string' ? init.model : null,
    permissionMode: typeof init?.permissionMode === 'string' ? init.permissionMode : typeof init?.permission_mode === 'string' ? init.permission_mode : null,
    skills: catalogNames(init?.skills),
    slashCommands: catalogNames(init?.slash_commands),
    responseText: [...records.filter(record => record.type === 'assistant').map(assistantText), resultText].filter(Boolean).join('\n'),
    successfulResult: Boolean(final && final.subtype === 'success' && final.is_error === false),
    effort: typeof init?.effort === 'string' ? init.effort : null,
  };
}

function parseFrontmatter(text: string, path: string): JsonObject {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`Skill has no valid YAML frontmatter: ${path}`);
  const value: unknown = parseYaml(match[1]!);
  if (!isObject(value)) throw new Error(`Skill frontmatter must be a mapping: ${path}`);
  return value;
}

export async function expectedSkills(paths: string[]): Promise<ExpectedSkill[]> {
  const roots = await Promise.all(paths.map(path => realpath(path)));
  const output: ExpectedSkill[] = [];
  async function walk(directory: string, root: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate, root);
      if (!entry.isFile() || entry.name !== 'SKILL.md') continue;
      const physical = await realpath(candidate);
      if (!isInside(physical, root)) throw new Error(`Skill source escaped selected root: ${candidate}`);
      const info = await stat(physical);
      if (info.size > MAX_SKILL_BYTES) throw new Error(`Skill exceeds ${MAX_SKILL_BYTES} bytes: ${candidate}`);
      const frontmatter = parseFrontmatter(await readFile(physical, 'utf8'), physical);
      if (typeof frontmatter.name !== 'string' || !/^mpx-[a-z0-9-]+$/.test(frontmatter.name)) throw new Error(`Skill frontmatter has invalid name: ${physical}`);
      if (frontmatter['disable-model-invocation'] !== undefined && typeof frontmatter['disable-model-invocation'] !== 'boolean') throw new Error(`disable-model-invocation must be boolean: ${physical}`);
      output.push({ name: frontmatter.name, path: physical, explicitOnly: frontmatter['disable-model-invocation'] === true });
    }
  }
  for (const root of roots) await walk(root, root);
  const duplicate = output.find((skill, index) => output.findIndex(other => other.name === skill.name) !== index);
  if (duplicate) throw new Error(`Duplicate expected MPX skill name: ${duplicate.name}`);
  return output;
}

export function validateCatalog(meta: StreamMeta, expected: ExpectedSkill[]): void {
  const expectedNames = new Set(expected.map(skill => skill.name));
  for (const catalog of [meta.skills, meta.slashCommands]) {
    const duplicate = catalog.find((name, index) => name.startsWith('mpx-') && catalog.indexOf(name) !== index);
    if (duplicate) throw new Error(`duplicate MPX catalog name: ${duplicate}`);
  }
  const unexpected = [...meta.skills, ...meta.slashCommands].find(name => name.startsWith('mpx-') && !expectedNames.has(name));
  if (unexpected) throw new Error(`unexpected out-of-selection MPX skill: ${unexpected}`);
  for (const skill of expected) {
    if (skill.explicitOnly && !meta.slashCommands.includes(skill.name)) throw new Error(`missing explicit-only catalog skill: ${skill.name}`);
    if (!skill.explicitOnly && !meta.skills.includes(skill.name) && !meta.slashCommands.includes(skill.name)) throw new Error(`missing catalog skill: ${skill.name}`);
  }
}

const defaultRunner: CommandRunner = (spec, args, timeout, maxBytes) =>
  runBounded(spec.executable, args, spec.cwd, timeout, maxBytes, undefined, spec.env);

export function validateAuthResult(result: ProcessResult): { loggedIn: true } {
  if (result.incomplete) throw new Error(`auth status unavailable: ${result.incomplete}`);
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('auth status returned invalid JSON'); }
  if (!isObject(data) || typeof data.loggedIn !== 'boolean') throw new Error('auth status omitted loggedIn boolean');
  if (!data.loggedIn) throw new Error('selected native account reported loggedIn=false');
  if (result.code !== 0) throw new Error(`auth status exited ${result.code} despite loggedIn=true`);
  return { loggedIn: true };
}
function requireSuccessfulProcess(result: ProcessResult, gate: string): void {
  if (result.incomplete) throw new Error(`${gate}: ${result.incomplete}`);
  if (result.code !== 0) {
    const expired = /401/.test(result.stdout) && /OAuth access token has expired/i.test(result.stdout);
    throw new Error(`${gate}: native CLI exited ${result.code}${expired ? '; selected native OAuth token expired; interactive reauthentication required' : ''}`);
  }
}

export async function execute(spec: LaunchSpec, expected: ExpectedSkill[], runner: CommandRunner = defaultRunner, marker: string = randomUUID()) {
  if (!marker || marker.length > 200) throw new Error('marker must be a short non-empty string');
  const safe = ['--print', '--output-format', 'stream-json', '--verbose', '--effort', 'low', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-budget-usd', '0.20'];
  const sessionId: string = randomUUID();
  const firstPrompt = `Remember this unique marker: ${marker}. Make no tool calls or mutations. Reply with exactly the marker.`;
  const first = await runner(spec, [...spec.args, ...safe, '--session-id', sessionId, firstPrompt], TIMEOUT_MS, OUTPUT_LIMIT);
  requireSuccessfulProcess(first, 'fresh');
  const initial = parseStream(first.stdout);
  if (!initial.successfulResult || initial.sessionId !== sessionId || initial.cwd !== resolve(spec.cwd) || !initial.model || !['default', 'auto'].includes(initial.permissionMode ?? '') || !initial.responseText.includes(marker)) throw new Error('fresh marker, final result, or native state mismatch');
  validateCatalog(initial, expected);

  const resumePrompt = 'What exact marker did I ask you to remember? Reply with only that marker.';
  const resumed = await runner(spec, [...spec.args, ...safe, '--resume', sessionId, resumePrompt], TIMEOUT_MS, OUTPUT_LIMIT);
  requireSuccessfulProcess(resumed, 'resume');
  const resume = parseStream(resumed.stdout);
  if (!resume.successfulResult || !resume.responseText.includes(marker) || resume.sessionId !== sessionId || resume.cwd !== initial.cwd || resume.model !== initial.model || resume.permissionMode !== initial.permissionMode) throw new Error('resumed marker, final result, or state mismatch');
  return {
    sessionId,
    model: initial.model,
    cwd: initial.cwd,
    permissionMode: initial.permissionMode,
    catalogs: { skills: initial.skills.length, slashCommands: initial.slashCommands.length },
    effort: { explicitOverride: 'low', observedInInitialInit: initial.effort === 'low', observedInResumeInit: resume.effort === 'low', savedRecoveryVerified: false },
    safety: { toolsDisabled: true, mcpDisabled: true },
  };
}

async function writeFailure(artifacts: string, gate: string, error: unknown): Promise<void> {
  const summary = { ok: false, gates: { [gate]: 'failed', later: 'unavailable' }, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
}

export async function main(argv = process.argv.slice(2), runner: CommandRunner = defaultRunner): Promise<void> {
  const options = parseArguments(argv);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const physicalCwd = await realpath(options.cwd);
  if (!(await stat(physicalCwd)).isDirectory()) throw new Error('--cwd is not a directory');
  const physicalParent = await realpath(dirname(options.artifacts));
  if (!(await stat(physicalParent)).isDirectory() || dirname(options.artifacts) !== physicalParent) throw new Error('--artifacts parent must be an existing physical path');
  if (await stat(options.artifacts).catch(() => undefined)) throw new Error('--artifacts must be a new owned directory');
  const project = await resolveProject(physicalCwd);
  if (!project.config) throw new Error('--cwd must be a registered MPX project');
  if (!process.env.APPDATA) throw new Error('APPDATA is unset');
  const config = await readUserConfig(join(process.env.APPDATA, 'mpx', 'config.json'));
  if (options.executable) {
    if (!(await stat(await realpath(options.executable)).catch(() => undefined))?.isFile()) throw new Error('--executable is not a physical file');
    config.executables = { ...config.executables, claude: await realpath(options.executable) };
  }
  const selection = await selectPacks(root, 'claude', options.account, project, config);
  const expected = await expectedSkills(selection.paths);
  await mkdir(options.artifacts);
  await writeFile(join(options.artifacts, '.native-claude-acceptance-owned'), 'owned\n', { flag: 'wx' });
  let gate = 'launch-spec';
  try {
    const clean = sanitizeProbeEnvironment(process.env);
    const spec = await createLaunchSpec({ root, cwd: physicalCwd, harness: 'claude', account: options.account, config, project, selection, args: [], env: clean.env });
    if (spec.requiresConfirmation) throw new Error('Acceptance refuses launches requiring confirmation');
    spec.env.DISABLE_AUTOUPDATER = '1';
    gate = 'auth';
    validateAuthResult(await runner(spec, ['auth', 'status', '--json'], 15_000, 64 * 1024));
    gate = 'native-probe';
    const run = await execute(spec, expected, runner);
    const summary = { ok: true, gates: { staticFiles: 'passed', auth: 'passed', catalog: 'passed', fresh: 'passed', resume: 'passed' }, account: options.account, accountRoot: config.accounts[options.account].claude, cwd: physicalCwd, packs: selection.packs, sourcePaths: selection.paths, removedInheritedOverrideNames: clean.removed, auth: { loggedIn: true }, run, limitations: ['Tools and MCP were disabled for non-mutating marker safety.', 'Saved effort recovery is unverified; low was explicitly supplied to both launches.'] };
    await writeFile(join(options.artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    await writeFailure(options.artifacts, gate, error);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`native-claude-acceptance: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
