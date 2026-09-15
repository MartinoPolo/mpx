import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveProject } from './config.js';
import type { FooterCompaction, FooterLocation, FooterQuotaWindow } from './pi-footer.js';

const executeFile = promisify(execFile);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

export function footerSessionCost(entries: readonly unknown[]): number | undefined {
  let cost = 0;
  for (const value of entries) {
    const entry = object(value);
    if (!entry) continue;
    const message = object(entry.message);
    const usage = entry.type === 'message' ? object(message?.usage) : object(entry.usage);
    const total = object(usage?.cost)?.total;
    if (total === undefined && !usage && message?.role !== 'assistant') continue;
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return undefined;
    cost += total;
  }
  return Number.isFinite(cost) ? cost : undefined;
}

export function footerCompactions(
  entries: readonly unknown[], reasons: ReadonlyMap<string, string>, sessionUrl?: string,
): FooterCompaction[] {
  const rows: FooterCompaction[] = [];
  for (const value of entries) {
    const entry = object(value);
    if (entry?.type !== 'compaction' || typeof entry.id !== 'string') continue;
    rows.push({
      id: entry.id,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      reason: reasons.get(entry.id),
      url: sessionUrl,
      ...(typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0
        ? { tokensBefore: entry.tokensBefore } : {}),
    });
  }
  return rows;
}

export function parseFooterQuota(headers: Record<string, string>, now: number): FooterQuotaWindow[] | undefined {
  const values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const number = (key: string): number | undefined => {
    const raw = values.get(key);
    if (raw === undefined || raw.trim() === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const windows: FooterQuotaWindow[] = [];
  for (const name of ['primary', 'secondary']) {
    const prefix = `x-codex-${name}-`;
    const usedPercent = number(`${prefix}used-percent`);
    if (usedPercent === undefined || usedPercent > 100) continue;
    const minutes = number(`${prefix}window-minutes`);
    const resetAt = number(`${prefix}reset-at`);
    const resetAfter = number(`${prefix}reset-after-seconds`);
    const reset = resetAt !== undefined && resetAt > 0
      ? resetAt > 1e12 ? resetAt : resetAt * 1000
      : resetAfter !== undefined ? now + resetAfter * 1000 : undefined;
    const label = !minutes ? name === 'primary' ? '5h' : '7d' : minutes % 1440 === 0 ? `${minutes / 1440}d`
      : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
    windows.push({ label, usedPercent, ...(reset === undefined ? {} : { resetAt: reset }) });
  }
  return windows.length ? windows : undefined;
}

export interface FooterReviewRepository {
  provider: 'github' | 'gitlab';
  target: string;
  url: string;
}

export interface FooterRepository {
  project: string;
  projectRoot: string;
  worktree: string;
  worktreeRoot: string;
  repositoryUrl?: string;
  provider?: string;
  reviewRepository?: FooterReviewRepository;
  headUrl?: string;
}

export function fallbackFooterRepository(cwd: string): FooterRepository {
  const root = path.resolve(cwd);
  return { project: path.basename(root), projectRoot: root, worktree: path.basename(root), worktreeRoot: root };
}

async function gitValue(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await executeFile('git', ['--no-optional-locks', '-C', cwd, ...args], {
      cwd: os.tmpdir(), windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024,
    });
    const value = result.stdout.trim();
    return value && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function reviewRepository(remote: string | undefined, provider: string | undefined): FooterReviewRepository | undefined {
  if (!remote || (provider !== 'github' && provider !== 'gitlab')) return undefined;
  const standard = /^(https?|ssh):\/\/([^/?#]+)(\/[^?#]*)$/.exec(remote);
  const scp = standard || /^[a-z][a-z+.-]*:\/\//i.test(remote)
    ? undefined : /^(?:[^@/:]+@)?([^@/:]+):(.+)$/.exec(remote);
  if (!standard && !scp) return undefined;
  try {
    const parsed = standard ? new URL(remote) : undefined;
    if (parsed && ((parsed.protocol !== 'ssh:' && (parsed.username || parsed.password)) || parsed.password)) return undefined;
    const host = scp?.[1] ?? parsed?.host;
    const rawPath = scp?.[2] ?? standard?.[3]?.replace(/^\//, '');
    if (!host || !rawPath) return undefined;
    const pathSegments = rawPath.replace(/\.git\/?$/, '').replace(/\/$/, '').split('/');
    if (!pathSegments.length || pathSegments.some(segment => {
      if (!segment) return true;
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    })) return undefined;
    const projectPath = pathSegments.join('/');
    return { provider, target: `${host}/${projectPath}`, url: `https://${host}/${projectPath}` };
  } catch {
    return undefined;
  }
}

function repositoryWebUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const scp = /^git@([^:/]+):(.+)$/.exec(remote);
  try {
    const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || (url.username && url.username !== 'git')) return undefined;
    if (url.protocol === 'ssh:') url.protocol = 'https:';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '');
    return url.href.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export async function resolveFooterRepository(cwd: string): Promise<FooterRepository> {
  const [project, worktreeRoot, gitDirectory] = await Promise.all([
    resolveProject(cwd),
    gitValue(cwd, ['rev-parse', '--show-toplevel']),
    gitValue(cwd, ['rev-parse', '--absolute-git-dir']),
  ]);
  if (!worktreeRoot) return fallbackFooterRepository(cwd);
  const projectRoot = project.mainCheckout ?? worktreeRoot;
  const remoteName = project.config?.repository.remote ?? 'origin';
  const remote = await gitValue(cwd, ['remote', 'get-url', '--', remoteName]);
  const repositoryUrl = repositoryWebUrl(remote);
  return {
    project: path.basename(projectRoot),
    projectRoot,
    worktree: path.basename(worktreeRoot),
    worktreeRoot,
    repositoryUrl,
    provider: project.config?.repository.provider ?? (repositoryUrl?.startsWith('https://github.com/') ? 'github' : undefined),
    reviewRepository: reviewRepository(remote, project.config?.repository.provider),
    headUrl: gitDirectory ? pathToFileURL(path.join(gitDirectory, 'HEAD')).href : undefined,
  };
}

function vscodeFolderUrl(folder: string): string {
  const fileUrl = pathToFileURL(folder);
  const windowsDrivePath = /^\/[a-z]:\//i.test(fileUrl.pathname);
  const folderPath = fileUrl.host
    ? `/${fileUrl.host}${fileUrl.pathname}`
    : windowsDrivePath ? fileUrl.pathname.slice(1) : fileUrl.pathname;
  return `vscode://file/${folderPath}`;
}

export function repositoryFooterLocation(repository: FooterRepository, branch: string | null): FooterLocation {
  const branchPath = repository.provider === 'github' ? '/tree/' : repository.provider === 'gitlab' ? '/-/tree/' : undefined;
  const isMainCheckout = path.relative(repository.projectRoot, repository.worktreeRoot) === '';
  return {
    project: repository.project,
    worktree: isMainCheckout ? undefined : repository.worktree,
    branch: branch ?? (repository.headUrl ? 'detached HEAD' : 'no branch'),
    projectUrl: pathToFileURL(repository.projectRoot).href,
    worktreeUrl: isMainCheckout ? undefined : pathToFileURL(repository.worktreeRoot).href,
    editorUrl: vscodeFolderUrl(repository.worktreeRoot),
    branchUrl: branch && branchPath && repository.repositoryUrl
      ? `${repository.repositoryUrl}${branchPath}${encodeURIComponent(branch)}` : repository.headUrl,
  };
}
