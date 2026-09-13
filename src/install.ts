import { lstat, mkdir, readlink, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import type { Account, Harness, UserConfig } from './contracts.js';

export interface AgentLink {
  source: string;
  destination: string;
  account: Account;
  harness: Harness;
}

export interface AgentLinkPlanningDiagnostic {
  harness: Harness;
  sourceDirectory: string;
  error: string;
}

interface AgentLinkScope {
  sourceDirectory: string;
  destinationDirectory: string;
  account: Account;
  harness: Harness;
}

export interface AgentLinkPlan {
  links: AgentLink[];
  errors: AgentLinkPlanningDiagnostic[];
  scopes: AgentLinkScope[];
}

export type AgentLinkStatus =
  | 'linked'
  | 'missing'
  | 'conflict'
  | 'stale'
  | 'unexpected'
  | 'source-missing'
  | 'source-conflict'
  | 'account-root-missing'
  | 'account-root-conflict'
  | 'agents-directory-conflict'
  | 'inspection-error';

export interface AgentLinkInspection {
  source?: string;
  destination: string;
  account: Account;
  harness: Harness;
  status: AgentLinkStatus;
  action: 'inspect';
  /** The text returned by readlink, retained even when its target is missing. */
  target?: string;
  error?: string;
}

export interface AgentLinkInspectionResult {
  ok: boolean;
  results: AgentLinkInspection[];
  errors: AgentLinkPlanningDiagnostic[];
}

export interface AgentLinkSyncEntry {
  source?: string;
  destination: string;
  account: Account;
  harness: Harness;
  status: AgentLinkStatus;
  action: 'created' | 'unchanged' | 'failed';
  target?: string;
  error?: string;
}

export interface AgentLinkSyncResult {
  ok: boolean;
  results: AgentLinkSyncEntry[];
  errors: AgentLinkPlanningDiagnostic[];
}

const accounts: readonly Account[] = ['personal', 'work'];
const harnesses: readonly Harness[] = ['pi', 'claude'];
const generatedAgentName = /^mpx-[^/\\]+\.md$/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function comparable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Plan only generated named specialist files; skill-pack roots are deliberately excluded. */
export async function planAgentLinks(root: string, config: UserConfig): Promise<AgentLinkPlan> {
  const links: AgentLink[] = [];
  const errors: AgentLinkPlanningDiagnostic[] = [];
  const scopes: AgentLinkScope[] = [];
  for (const harness of harnesses) {
    const sourceDirectory = path.resolve(root, 'dist', harness, 'agents');
    for (const account of accounts) scopes.push({ sourceDirectory, destinationDirectory: path.resolve(config.accounts[account][harness], 'agents'), account, harness });
    let names: string[];
    try {
      const directory = await lstat(sourceDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('source agents path is not a real directory');
      names = (await readdir(sourceDirectory)).filter(name => generatedAgentName.test(name)).sort();
    } catch (error) {
      errors.push({ harness, sourceDirectory, error: `cannot plan ${harness} agent links from ${sourceDirectory}: ${message(error)}` });
      continue;
    }

    for (const account of accounts) {
      const accountRoot = path.resolve(config.accounts[account][harness]);
      for (const filename of names) {
        links.push({
          source: path.join(sourceDirectory, filename),
          destination: path.join(accountRoot, 'agents', filename),
          account,
          harness,
        });
      }
    }
  }
  return { links, errors, scopes };
}

type ChainResult = { kind: 'ok' } | { kind: 'missing'; path: string } | { kind: 'conflict'; path: string } | { kind: 'error'; path: string; error: unknown };

/** lstat every component so an ancestor junction cannot redirect installer mutations. */
async function validateDirectoryChain(target: string, allowLeafMissing = false): Promise<ChainResult> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const paths = [current, ...parts.map(part => (current = path.join(current, part)))];
  for (let index = 0; index < paths.length; index += 1) {
    const component = paths[index]!;
    try {
      const stat = await lstat(component);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: 'conflict', path: component };
    } catch (error) {
      if (isMissing(error)) {
        if (allowLeafMissing && index === paths.length - 1) return { kind: 'missing', path: component };
        return { kind: 'missing', path: component };
      }
      return { kind: 'error', path: component, error };
    }
  }
  return { kind: 'ok' };
}

async function inspectOne(entry: AgentLink): Promise<AgentLinkInspection> {
  const base = { ...entry, action: 'inspect' as const };
  try {
    const source = await lstat(entry.source);
    if (!source.isFile() || source.isSymbolicLink()) {
      return { ...base, status: 'source-conflict', error: `source is not a regular generated file: ${entry.source}` };
    }
  } catch (error) {
    return isMissing(error)
      ? { ...base, status: 'source-missing', error: `source is missing: ${entry.source}` }
      : { ...base, status: 'inspection-error', error: `cannot inspect source ${entry.source}: ${message(error)}` };
  }

  const accountRoot = path.dirname(path.dirname(entry.destination));
  const root = await validateDirectoryChain(accountRoot);
  if (root.kind !== 'ok') {
    if (root.kind === 'missing') return { ...base, status: 'account-root-missing', error: `account root component is missing: ${root.path}` };
    if (root.kind === 'conflict') return { ...base, status: 'account-root-conflict', error: `account root component is not a real directory: ${root.path}` };
    return { ...base, status: 'inspection-error', error: `cannot inspect account root component ${root.path}: ${message(root.error)}` };
  }

  const agentsDirectory = path.dirname(entry.destination);
  const agents = await validateDirectoryChain(agentsDirectory, true);
  if (agents.kind === 'missing') return { ...base, status: 'missing' };
  if (agents.kind === 'conflict') return { ...base, status: 'agents-directory-conflict', error: `agents path component is not a real directory: ${agents.path}` };
  if (agents.kind === 'error') return { ...base, status: 'inspection-error', error: `cannot inspect agents path component ${agents.path}: ${message(agents.error)}` };

  try {
    const destination = await lstat(entry.destination);
    if (!destination.isSymbolicLink()) {
      return { ...base, status: 'conflict', error: `destination exists and is not an owned symlink: ${entry.destination}` };
    }
    const target = await readlink(entry.destination);
    const resolvedTarget = path.resolve(agentsDirectory, target);
    return comparable(resolvedTarget) === comparable(entry.source)
      ? { ...base, status: 'linked', target }
      : { ...base, status: 'conflict', target, error: `symlink target conflicts at ${entry.destination}; expected ${entry.source}` };
  } catch (error) {
    if (isMissing(error)) return { ...base, status: 'missing' };
    return { ...base, status: 'inspection-error', error: `cannot inspect destination ${entry.destination}: ${message(error)}` };
  }
}

async function inspectLeftovers(plan: AgentLinkPlan): Promise<AgentLinkInspection[]> {
  const expected = new Set(plan.links.map(entry => comparable(entry.destination)));
  const results: AgentLinkInspection[] = [];

  for (const entry of plan.scopes) {
    const agentsDirectory = entry.destinationDirectory;
    const chain = await validateDirectoryChain(agentsDirectory);
    if (chain.kind !== 'ok') continue; // inspectOne reports unsafe expected entries; never traverse them here.
    let names: string[];
    try {
      names = (await readdir(agentsDirectory)).filter(name => generatedAgentName.test(name)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const destination = path.join(agentsDirectory, name);
      if (expected.has(comparable(destination))) continue;
      const base = { destination, account: entry.account, harness: entry.harness, action: 'inspect' as const };
      try {
        const stat = await lstat(destination);
        if (!stat.isSymbolicLink()) {
          results.push({ ...base, status: 'unexpected', error: `unexpected non-link mpx agent is preserved: ${destination}` });
          continue;
        }
        const target = await readlink(destination);
        const resolvedTarget = path.resolve(agentsDirectory, target);
        const sourceDirectory = entry.sourceDirectory;
        if (comparable(path.dirname(resolvedTarget)) === comparable(sourceDirectory) && generatedAgentName.test(path.basename(resolvedTarget))) {
          results.push({ ...base, source: resolvedTarget, target, status: 'stale', error: `stale managed agent link is preserved: ${destination}` });
        } else {
          results.push({ ...base, source: resolvedTarget, target, status: 'conflict', error: `unexpected mpx agent link target is preserved: ${destination}` });
        }
      } catch (error) {
        results.push({ ...base, status: 'inspection-error', error: `cannot inspect unexpected agent ${destination}: ${message(error)}` });
      }
    }
  }
  return results;
}

export async function inspectAgentLinks(plan: AgentLinkPlan): Promise<AgentLinkInspectionResult> {
  const results = [...await Promise.all(plan.links.map(inspectOne)), ...await inspectLeftovers(plan)];
  return { ok: plan.errors.length === 0 && results.every(result => result.status === 'linked' || result.status === 'missing'), results, errors: [...plan.errors] };
}

export async function syncAgentLinks(plan: AgentLinkPlan): Promise<AgentLinkSyncResult> {
  const results: AgentLinkSyncEntry[] = [];
  for (const entry of plan.links) {
    const inspection = await inspectOne(entry);
    if (inspection.status === 'linked') {
      results.push({ ...entry, status: 'linked', action: 'unchanged', ...(inspection.target !== undefined ? { target: inspection.target } : {}) });
      continue;
    }
    if (inspection.status !== 'missing') {
      results.push({ ...entry, status: inspection.status, action: 'failed', ...(inspection.target !== undefined ? { target: inspection.target } : {}), ...(inspection.error ? { error: inspection.error } : {}) });
      continue;
    }

    const agentsDirectory = path.dirname(entry.destination);
    try {
      const accountRoot = path.dirname(agentsDirectory);
      const beforeMkdir = await validateDirectoryChain(accountRoot);
      if (beforeMkdir.kind !== 'ok') throw new Error(`account root path became unsafe at ${beforeMkdir.path}`);
      try {
        await mkdir(agentsDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const beforeLink = await validateDirectoryChain(agentsDirectory);
      if (beforeLink.kind !== 'ok') throw new Error(`agents path became unsafe at ${beforeLink.path}`);
      const source = await lstat(entry.source);
      if (!source.isFile() || source.isSymbolicLink()) throw new Error(`source is not a regular generated file: ${entry.source}`);
      await symlink(entry.source, entry.destination, 'file');
      results.push({ ...entry, status: 'linked', action: 'created' });
    } catch (error) {
      results.push({ ...entry, status: 'conflict', action: 'failed', error: `failed to create symlink from ${entry.source} to ${entry.destination}: ${message(error)}` });
    }
  }

  const leftovers = await inspectLeftovers(plan);
  for (const item of leftovers) results.push({ ...item, action: 'failed' });
  return { ok: plan.errors.length === 0 && results.every(result => result.action !== 'failed'), results, errors: [...plan.errors] };
}
