import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account, Harness, UserConfig } from '../src/contracts.js';
import { planAgentLinks, syncAgentLinks, type AgentLinkPlan } from '../src/install.js';
import { syncRuntimeScope } from '../src/runtime-install.js';

interface PilotBackupModule { backupPilot(options: { sources: string[]; destinationRoot: string; protectRoot: (root: string) => Promise<void> }): Promise<unknown>; protectWindowsRoot(root: string): Promise<void> }
const { backupPilot, protectWindowsRoot } = await import(new URL('./pilot-backup.mjs', import.meta.url).href) as PilotBackupModule;
const { recoverAccountRollout } = await import(new URL('./account-rollout-recovery.mjs', import.meta.url).href) as { recoverAccountRollout(planPath: string): Promise<void> };

export interface LegacyRuleMapping { name: 'css.md' | 'python.md' | 'rust.md' | 'svelte.md' | 'typescript.md'; sourceRoot: string; destination: string }
export interface RetiredSkillLink { name: string; target: string }
export interface PrepareAccountRolloutOptions {
  account: Account; harness: Harness; config: UserConfig; root: string; backupRoot: string; approvedLegacyRoots: string[];
  approvedDisplayPackage?: string; approvedLegacySkillRoots?: string[]; approvedLegacySkillLinks?: string[]; legacySkillExclusions?: string[];
  legacyRuleMappings?: LegacyRuleMapping[]; approvedLegacyTerseSource?: string; retiredSkillLinks?: RetiredSkillLink[];
  protectRoot?: (root: string) => Promise<void>; observeRead?: (operation: 'lstat' | 'read' | 'readdir' | 'readlink', candidate: string) => void;
}
interface Fingerprint { type: 'missing' | 'file' | 'directory' | 'link'; sha256?: string; target?: string; entries?: Record<string, Fingerprint>; resolved?: Fingerprint }
interface RolloutEntry {
  relative: string; destination: string; staged: string; candidate: string; retained: string; retainedAfter: string;
  before: Fingerprint; beforeTopology: Fingerprint; after: Fingerprint; afterTopology: Fingerprint; parentWasMissing: boolean;
}
export interface AccountRolloutPlan {
  version: 1; id: string; state: 'prepared' | 'applying' | 'applied' | 'rolling-back' | 'rolled-back'; account: Account; harness: Harness;
  accountRoot: string; root: string; backupRoot: string; stagingRoot: string; planPath: string; recoveryPath: string; recoveryFingerprint: Fingerprint; entries: RolloutEntry[];
}
export interface ApplyInjection { failAfterMutations?: number; failCompensationAfterOperations?: number }

const SURFACES: Record<Harness, readonly string[]> = {
  pi: ['settings.json', 'subagents.json', 'keybindings.json', 'agents', 'extensions/mpx.ts'],
  claude: ['settings.json', 'rules', 'output-styles', 'agents', 'skills'],
};
const MAX_FILES = 50_000; const MAX_BYTES = 256 * 1024 * 1024; const MAX_DEPTH = 64;
const slash = (value: string) => value.replaceAll('\\', '/');
const comparable = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function inside(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function approved(candidate: string, roots: readonly string[]): boolean { return roots.some(root => inside(comparable(root), comparable(candidate))); }
function same(a: Fingerprint, b: Fingerprint): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
interface Budget { files: number; bytes: number; seen: Set<string>; observe?: PrepareAccountRolloutOptions['observeRead'] }
async function boundedFingerprint(candidate: string, resolveLinks = false, budget: Budget = { files: 0, bytes: 0, seen: new Set() }, depth = 0): Promise<Fingerprint> {
  if (depth > MAX_DEPTH) throw new Error(`surface exceeds fingerprint depth limit (${MAX_DEPTH}): ${candidate}`);
  budget.observe?.('lstat', candidate); let info;
  try { info = await lstat(candidate); } catch (error) { if (isMissing(error)) return { type: 'missing' }; throw error; }
  if (++budget.files > MAX_FILES) throw new Error(`surface exceeds fingerprint entry limit (${MAX_FILES})`);
  if (info.isSymbolicLink()) {
    budget.observe?.('readlink', candidate); const target = await readlink(candidate); const result: Fingerprint = { type: 'link', target };
    if (resolveLinks) {
      const resolved = await realpath(candidate); const key = comparable(resolved); if (budget.seen.has(key)) throw new Error(`cyclic resolved link: ${candidate}`);
      budget.seen.add(key); result.resolved = await boundedFingerprint(resolved, true, budget, depth + 1); budget.seen.delete(key);
    }
    return result;
  }
  if (info.isFile()) {
    if (info.size > MAX_BYTES - budget.bytes) throw new Error(`surface exceeds fingerprint byte limit (${MAX_BYTES})`);
    budget.bytes += info.size; budget.observe?.('read', candidate); const handle = await open(candidate, 'r'); const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let total = 0;
    try { for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; if (total > info.size) throw new Error(`file grew during fingerprint: ${candidate}`); hash.update(buffer.subarray(0, bytesRead)); } } finally { await handle.close(); }
    const after = await lstat(candidate); if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || total !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error(`file changed during fingerprint: ${candidate}`);
    return { type: 'file', sha256: hash.digest('hex') };
  }
  if (!info.isDirectory()) throw new Error(`unsupported account surface type: ${candidate}`);
  budget.observe?.('readdir', candidate); const names = (await readdir(candidate)).sort(); if (budget.files + names.length > MAX_FILES) throw new Error(`surface exceeds fingerprint entry limit (${MAX_FILES})`);
  const entries: Record<string, Fingerprint> = {}; for (const name of names) entries[name] = await boundedFingerprint(path.join(candidate, name), resolveLinks, budget, depth + 1);
  return { type: 'directory', entries };
}
async function statKind(candidate: string): Promise<'missing' | 'file' | 'directory' | 'link' | 'other'> {
  try { const info = await lstat(candidate); return info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'; } catch (error) { if (isMissing(error)) return 'missing'; throw error; }
}
async function physicalDirectory(candidate: string): Promise<void> { let cursor = path.resolve(candidate); for (;;) { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`not a physical directory: ${cursor}`); const parent = path.dirname(cursor); if (parent === cursor) return; cursor = parent; } }
async function physicalExistingAncestors(candidate: string): Promise<void> { let cursor = path.resolve(candidate); for (;;) { try { const kind = await statKind(cursor); if (kind === 'directory') return physicalDirectory(cursor); if (kind !== 'missing') throw new Error(`unsafe ancestor type: ${cursor}`); } catch (error) { if (!isMissing(error)) throw error; } const parent = path.dirname(cursor); if (parent === cursor) throw new Error(`no physical ancestor: ${candidate}`); cursor = parent; } }
async function collectLinks(candidate: string, nested = false): Promise<string[]> { const kind = await statKind(candidate); if (kind === 'missing') return []; if (kind === 'link') return [candidate]; if (kind !== 'directory') return []; const links: string[] = []; for (const name of await readdir(candidate)) links.push(...await collectLinks(path.join(candidate, name), true)); return links; }
async function copyMaterialized(source: string, destination: string): Promise<void> { const info = await lstat(source); await mkdir(path.dirname(destination), { recursive: true }); if (info.isSymbolicLink()) return copyMaterialized(await realpath(source), destination); if (info.isDirectory()) return void await cp(source, destination, { recursive: true, dereference: false, errorOnExist: true }); if (info.isFile()) return void await cp(source, destination, { errorOnExist: true }); throw new Error(`unsupported surface: ${source}`); }
async function copyPostimage(source: string, destination: string): Promise<void> { const info = await lstat(source); await mkdir(path.dirname(destination), { recursive: true }); if (info.isSymbolicLink()) return void await symlink(await readlink(source), destination, info.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); if (info.isDirectory()) return void await cp(source, destination, { recursive: true, dereference: false, errorOnExist: true }); if (info.isFile()) return void await cp(source, destination, { errorOnExist: true }); throw new Error(`unsupported staged surface: ${source}`); }
async function persist(plan: AccountRolloutPlan): Promise<void> { const temporary = `${plan.planPath}.${randomUUID()}.tmp`; const handle = await open(temporary, 'wx'); try { await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); } await rename(temporary, plan.planPath); const directory = await open(path.dirname(plan.planPath), 'r'); try { await directory.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }); } finally { await directory.close(); } }
function stageConfig(config: UserConfig, account: Account, harness: Harness, stagingRoot: string): UserConfig { const clone = structuredClone(config); clone.accounts[account][harness] = stagingRoot; return clone; }
function samePathValue(a: string, b: string): boolean { return comparable(a.replaceAll('/', path.sep)) === comparable(b.replaceAll('/', path.sep)); }
async function transformPi(options: PrepareAccountRolloutOptions, stagingRoot: string): Promise<void> {
  const file = path.join(stagingRoot, 'settings.json'); let value: Record<string, unknown> = {};
  try { value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; } catch (error) { if (!isMissing(error)) throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi settings must be an object');
  if (value.packages !== undefined && (!Array.isArray(value.packages) || value.packages.some(item => typeof item !== 'string' && (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).source !== 'string')))) throw new Error('Pi packages must be strings or source objects');
  if (value.skills !== undefined && (!Array.isArray(value.skills) || value.skills.some(item => typeof item !== 'string'))) throw new Error('Pi skills must be an array of strings');
  if (options.approvedDisplayPackage !== undefined) {
    if (!path.isAbsolute(options.approvedDisplayPackage) || !approved(options.approvedDisplayPackage, options.approvedLegacyRoots)) throw new Error('display package is not under an approved legacy root');
    if (Array.isArray(value.packages)) value.packages = value.packages.map(item => typeof item === 'string' && samePathValue(item, options.approvedDisplayPackage!) ? { source: item, extensions: [] } : item && typeof item === 'object' && samePathValue(String((item as Record<string, unknown>).source), options.approvedDisplayPackage!) ? { ...(item as Record<string, unknown>), extensions: [] } : item);
  }
  const skillRoots = options.approvedLegacySkillRoots ?? []; if (skillRoots.some(root => !path.isAbsolute(root) || !approved(root, options.approvedLegacyRoots))) throw new Error('skill root is not approved');
  const skillLinks = options.approvedLegacySkillLinks ?? []; if (skillLinks.some(link => !path.isAbsolute(link))) throw new Error('legacy skill links must be absolute');
  const currentSkills = (value.skills ?? []) as string[];
  value.skills = currentSkills.filter(item => item.startsWith('!') || (!skillRoots.some(root => inside(comparable(root), comparable(item))) && !skillLinks.some(link => samePathValue(link, item))));
  const exclusions = options.legacySkillExclusions ?? []; if (exclusions.some(root => !path.isAbsolute(root))) throw new Error('skill exclusions must be absolute');
  for (const exclusion of exclusions) { const item = `!${slash(exclusion)}/**`; if (!(value.skills as string[]).some(existing => samePathValue(existing.slice(1, -3), exclusion))) (value.skills as string[]).push(item); }
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function prepareClaude(options: PrepareAccountRolloutOptions, stagingRoot: string): Promise<void> {
  for (const mapping of options.legacyRuleMappings ?? []) {
    if (!path.isAbsolute(mapping.sourceRoot) || !approved(mapping.sourceRoot, options.approvedLegacyRoots)) throw new Error('rule mapping source root is not approved');
    if (comparable(mapping.destination) !== comparable(path.join(options.root, 'dist/claude/rules/languages', mapping.name)) || await statKind(mapping.destination) !== 'file') throw new Error(`mapped rule destination missing or invalid: ${mapping.name}`);
    const legacy = await boundedFingerprint(path.join(mapping.sourceRoot, mapping.name)); const staged = path.join(stagingRoot, 'rules', mapping.name);
    if (legacy.type !== 'file' || !same(legacy, await boundedFingerprint(staged))) throw new Error(`mapped legacy rule mismatch: ${mapping.name}`); await rm(staged);
  }
  for (const retired of options.retiredSkillLinks ?? []) {
    if (!retired.name || path.basename(retired.name) !== retired.name || !path.isAbsolute(retired.target)) throw new Error('retired skill link requires safe name and absolute target');
    const original = path.join(options.config.accounts[options.account][options.harness], 'skills', retired.name);
    if (await statKind(original) !== 'link' || comparable(await realpath(original)) !== comparable(retired.target) || !approved(retired.target, options.approvedLegacyRoots)) throw new Error(`retired skill link target mismatch: ${retired.name}`);
    await rm(path.join(stagingRoot, 'skills', retired.name));
  }
  const oldTerse = path.join(stagingRoot, 'output-styles/mp-terse.md');
  if (options.approvedLegacyTerseSource && await statKind(oldTerse) !== 'missing') {
    if (await statKind(oldTerse) !== 'link' || !options.approvedLegacyTerseSource || comparable(await realpath(oldTerse)) !== comparable(options.approvedLegacyTerseSource) || !approved(options.approvedLegacyTerseSource, options.approvedLegacyRoots)) throw new Error('legacy terse replacement is not explicitly approved');
    await rm(oldTerse);
  }
}

/** Creates protected scope-only snapshots and staging without mutating account resources. */
export async function prepareAccountRollout(options: PrepareAccountRolloutOptions): Promise<AccountRolloutPlan> {
  if (!path.isAbsolute(options.root) || !path.isAbsolute(options.backupRoot)) throw new Error('root and backupRoot must be absolute');
  const accountRoot = path.resolve(options.config.accounts[options.account][options.harness]); await physicalDirectory(accountRoot);
  if (inside(accountRoot, options.backupRoot) || inside(options.backupRoot, accountRoot)) throw new Error('backupRoot and accountRoot must not overlap');
  if (await statKind(options.backupRoot) !== 'missing') throw new Error('backupRoot already exists'); await mkdir(options.backupRoot); await (options.protectRoot ?? protectWindowsRoot)(options.backupRoot);
  const recoveryPath = path.join(options.backupRoot, 'account-rollout-recovery.mjs'); await cp(fileURLToPath(new URL('./account-rollout-recovery.mjs', import.meta.url)), recoveryPath, { errorOnExist: true });
  const stagingRoot = path.join(options.backupRoot, 'staging'); await mkdir(stagingRoot);
  const stagedConfig = stageConfig(options.config, options.account, options.harness, stagingRoot); const planned = await planAgentLinks(options.root, stagedConfig); const links = planned.links.filter(link => link.account === options.account && link.harness === options.harness);
  if (planned.errors.some(error => error.harness === options.harness)) throw new Error('cannot plan generated agent links');
  const managedSources = new Set(links.map(link => comparable(link.source))); if (options.harness === 'claude') { managedSources.add(comparable(path.join(options.root, 'dist/claude/rules'))); managedSources.add(comparable(path.join(options.root, 'dist/claude/output-styles/mpx-terse.md'))); }
  const before = new Map<string, Fingerprint>(); const beforeTopology = new Map<string, Fingerprint>(); let snapshotIndex = 0;
  for (const relative of SURFACES[options.harness]) {
    const source = path.join(accountRoot, relative); const topology = await boundedFingerprint(source, false, { files: 0, bytes: 0, seen: new Set(), observe: options.observeRead }); beforeTopology.set(relative, topology);
    if (topology.type === 'missing') { before.set(relative, topology); continue; }
    const links = await collectLinks(source); if (topology.type === 'link') links.push(...await collectLinks(await realpath(source)));
    const resolvedLinks: string[] = [];
    for (const link of links) { const resolved = await realpath(link); if (!approved(resolved, options.approvedLegacyRoots) && !managedSources.has(comparable(resolved))) throw new Error(`symlink source outside approved roots: ${link}`); resolvedLinks.push(resolved); }
    const observed = await boundedFingerprint(source, true, { files: 0, bytes: 0, seen: new Set(), observe: options.observeRead }); before.set(relative, observed);
    await backupPilot({ sources: [source], destinationRoot: path.join(options.backupRoot, `snapshot-${snapshotIndex++}`), protectRoot: options.protectRoot ?? protectWindowsRoot });
    for (const resolved of resolvedLinks) await backupPilot({ sources: [resolved], destinationRoot: path.join(options.backupRoot, `snapshot-${snapshotIndex++}`), protectRoot: options.protectRoot ?? protectWindowsRoot });
    await copyMaterialized(source, path.join(stagingRoot, relative));
  }
  if (options.harness === 'pi') await transformPi(options, stagingRoot); else await prepareClaude(options, stagingRoot);
  const runtime = await syncRuntimeScope(options.root, stagedConfig, { account: options.account, harness: options.harness }, false);
  if (!runtime.ok) throw new Error(`cannot stage runtime: ${runtime.entries.filter(item => item.status === 'conflict').map(item => item.diagnostic).join('; ')}`);
  for (const link of links) { const kind = await statKind(link.destination); if (kind === 'missing') continue; if (kind !== 'link' || comparable(await realpath(link.destination)) !== comparable(link.source)) throw new Error(`generated agent destination conflicts with existing definition: ${link.destination}`); }
  const scopedPlan: AgentLinkPlan = { links, errors: [], scopes: planned.scopes.filter(scope => scope.account === options.account && scope.harness === options.harness) }; const synced = await syncAgentLinks(scopedPlan); if (!synced.ok) throw new Error('cannot stage generated agent links');
  const id = randomUUID(); const entries: RolloutEntry[] = [];
  for (const relative of SURFACES[options.harness]) {
    const destination = path.join(accountRoot, relative); const staged = path.join(stagingRoot, relative); const suffix = `.mpx-${id}`;
    entries.push({ relative, destination, staged, candidate: `${destination}${suffix}-candidate`, retained: `${destination}${suffix}-original`, retainedAfter: `${destination}${suffix}-postimage`, before: before.get(relative)!, beforeTopology: beforeTopology.get(relative)!, after: await boundedFingerprint(staged, true), afterTopology: await boundedFingerprint(staged, false), parentWasMissing: await statKind(path.dirname(destination)) === 'missing' });
  }
  const plan: AccountRolloutPlan = { version: 1, id, state: 'prepared', account: options.account, harness: options.harness, accountRoot, root: options.root, backupRoot: options.backupRoot, stagingRoot, planPath: path.join(options.backupRoot, 'account-rollout-plan.json'), recoveryPath, recoveryFingerprint: await boundedFingerprint(recoveryPath), entries }; await persist(plan); return plan;
}
async function matches(candidate: string, expected: Fingerprint, topology: Fingerprint): Promise<boolean> { return same(await boundedFingerprint(candidate, false), topology) && same(await boundedFingerprint(candidate, true), expected); }
async function safeResolved(candidate: string, alternatives: Array<{ value: Fingerprint; topology: Fingerprint }>): Promise<Fingerprint> { const topology = await boundedFingerprint(candidate, false); const match = alternatives.find(item => same(topology, item.topology)); if (!match) throw new Error(`unrecognized topology without following links: ${candidate}`); return boundedFingerprint(candidate, true); }
async function preflight(plan: AccountRolloutPlan): Promise<void> {
  if (plan.state !== 'prepared') throw new Error('rollout plan is not prepared'); const durable = JSON.parse(await readFile(plan.planPath, 'utf8')) as AccountRolloutPlan; if (JSON.stringify(durable) !== JSON.stringify(plan)) throw new Error('durable rollout plan differs');
  if (!same(await boundedFingerprint(plan.recoveryPath), plan.recoveryFingerprint)) throw new Error('recovery bytes changed'); await physicalDirectory(plan.accountRoot);
  for (const entry of plan.entries) { if (!await matches(entry.destination, entry.before, entry.beforeTopology) || !await matches(entry.staged, entry.after, entry.afterTopology)) throw new Error(`surface drift: ${entry.relative}`); for (const artifact of [entry.candidate, entry.retained, entry.retainedAfter]) if (await statKind(artifact) !== 'missing') throw new Error(`rollout artifact conflict: ${artifact}`); if (entry.parentWasMissing && await statKind(path.dirname(entry.destination)) !== 'missing') throw new Error(`ancestor drift: ${entry.relative}`); await physicalExistingAncestors(path.dirname(entry.destination)); }
}
async function compensate(plan: AccountRolloutPlan, injection: ApplyInjection): Promise<void> {
  const errors: unknown[] = []; let operations = 0; const step = async (operation: () => Promise<void>) => { if (++operations === injection.failCompensationAfterOperations) throw new Error('injected compensation failure'); await operation(); };
  for (const entry of [...plan.entries].reverse()) {
    try {
      const missing: Fingerprint = { type: 'missing' };
      const live = await safeResolved(entry.destination, [{ value: entry.before, topology: entry.beforeTopology }, { value: entry.after, topology: entry.afterTopology }, { value: missing, topology: missing }]);
      const retained = await safeResolved(entry.retained, [{ value: entry.before, topology: entry.beforeTopology }, { value: missing, topology: missing }]); const candidate = await boundedFingerprint(entry.candidate, false);
      if (same(live, entry.before) && retained.type === 'missing') continue;
      if (same(live, entry.after)) { if (await statKind(entry.retainedAfter) !== 'missing') throw new Error(`postimage quarantine exists: ${entry.retainedAfter}`); await step(() => rename(entry.destination, entry.retainedAfter)); if (!await matches(entry.retainedAfter, entry.after, entry.afterTopology)) throw new Error(`postimage quarantine verification failed: ${entry.retainedAfter}`); }
      else if (!same(live, entry.before) && live.type !== 'missing') throw new Error(`cannot compensate changed destination: ${entry.destination}`);
      if (entry.before.type !== 'missing' && (await statKind(entry.destination)) === 'missing') { if (!same(retained, entry.before)) throw new Error(`retained original mismatch: ${entry.retained}`); await step(() => rename(entry.retained, entry.destination)); }
      if (candidate.type !== 'missing' && !same(candidate, entry.afterTopology)) throw new Error(`candidate changed: ${entry.candidate}`);
      if (!await matches(entry.destination, entry.before, entry.beforeTopology)) throw new Error(`original restoration verification failed: ${entry.destination}`);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) { plan.state = 'applying'; await persist(plan); throw new AggregateError(errors, 'apply failed and compensation is incomplete'); }
  plan.state = 'rolled-back'; await persist(plan);
}
/** Builds verified adjacent candidates, then performs only atomic whole-surface switches. */
export async function applyAccountRollout(plan: AccountRolloutPlan, injection: ApplyInjection = {}): Promise<void> {
  await preflight(plan); plan.state = 'applying'; await persist(plan); let mutations = 0;
  try {
    for (const entry of plan.entries) { if (entry.after.type === 'missing' || same(entry.before, entry.after)) continue; if (entry.parentWasMissing) await mkdir(path.dirname(entry.destination)); await copyPostimage(entry.staged, entry.candidate); if (!await matches(entry.candidate, entry.after, entry.afterTopology)) throw new Error(`candidate verification failed: ${entry.relative}`); }
    for (const entry of plan.entries) {
      if (same(entry.before, entry.after)) {
        if (!await matches(entry.destination, entry.before, entry.beforeTopology)) throw new Error(`unchanged surface drift: ${entry.relative}`);
        continue;
      }
      if (!await matches(entry.destination, entry.before, entry.beforeTopology) || !await matches(entry.staged, entry.after, entry.afterTopology) || (entry.after.type !== 'missing' && !await matches(entry.candidate, entry.after, entry.afterTopology))) throw new Error(`last-moment drift: ${entry.relative}`);
      await physicalExistingAncestors(path.dirname(entry.destination));
      if (entry.before.type !== 'missing') { await rename(entry.destination, entry.retained); if (!await matches(entry.retained, entry.before, entry.beforeTopology)) throw new Error(`retained verification failed: ${entry.relative}`); if (++mutations === injection.failAfterMutations) throw new Error('injected apply failure'); }
      if (entry.after.type !== 'missing') { await rename(entry.candidate, entry.destination); if (!await matches(entry.destination, entry.after, entry.afterTopology)) throw new Error(`installed verification failed: ${entry.relative}`); if (++mutations === injection.failAfterMutations) throw new Error('injected apply failure'); }
    }
    plan.state = 'applied'; await persist(plan);
  } catch (applyError) { try { await compensate(plan, injection); } catch (compensationError) { throw new AggregateError([applyError, compensationError], 'apply failed; compensation incomplete; use protected recovery'); } throw applyError; }
}
/** Conservative rollback is implemented by the copied Node-only recovery program. */
export async function rollbackAccountRollout(plan: AccountRolloutPlan): Promise<void> { await recoverAccountRollout(plan.planPath); plan.state = 'rolled-back'; }
