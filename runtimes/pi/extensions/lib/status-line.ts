import path from 'node:path';

import { isNonNegativeInt } from './statusline-ansi.js';

export const INDENT_GUARD = '⠀';

export interface GitStatus {
  branch: string;
  hasUpstream: boolean;
  hasAheadBehind: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  conflicts: number;
  untracked: number;
}

export interface MrFields {
  timestamp: string;
  provider: string;
  iid: string;
  draft: string;
  conflicts: string;
  approved: string;
  approvalsRequired: string;
  approvalsLeft: string;
  status: string;
  notes: string;
  pipeline: string;
  url: string;
  fetchEpoch: string;
}

export interface ProjectLocation {
  projectName: string;
  projectUrl: string;
  worktreeName: string;
  worktreeUrl: string;
  projectDir: string;
}

export interface WorktreePaths {
  commonDir: string;
  toplevel: string;
}

function basename(input: string): string {
  if (input === '') {
    return '';
  }
  const trimmed = input.replace(/[/\\]+$/, '');
  if (trimmed === '') {
    return input[0] === '/' ? '/' : '\\';
  }
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1);
}

function encodeBranchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function nowSeconds(): number {
  return Math.trunc(Date.now() / 1000);
}

function numericPrefix(value: string): number {
  const match = /^[ \t]*[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(value);
  return match ? Number(match[0]) : 0;
}

function remoteWebRoot(remote: string): string {
  let url = remote.trim();
  if (url === '') {
    return '';
  }
  const scpLike = url.match(/^[\w.+-]+@([^:/]+):(.+)$/);
  if (scpLike) {
    url = `https://${scpLike[1]}/${scpLike[2]}`;
  }
  url = url
    .replace(/^(?:ssh|git):\/\/(?:[\w.+-]+@)?/, 'https://')
    .replace(/^https:\/\/([^/:]+):\d+\//, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return /^https?:\/\/[^/]+\/.+/.test(url) ? url : '';
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(left) === normalize(right);
}

function webViewPath(webRoot: string, view: 'tree' | 'compare'): string {
  return /^https?:\/\/[^/]*gitlab/i.test(webRoot) ? `/-/${view}/` : `/${view}/`;
}

export function buildBranchUrl(remote: string, branch: string): string {
  const webRoot = remoteWebRoot(remote);
  if (webRoot === '' || branch === '') {
    return '';
  }
  return webRoot + webViewPath(webRoot, 'tree') + encodeBranchPath(branch);
}

export function buildCiUrl(mergeRequest: MrFields): string {
  if (mergeRequest.url === '') {
    return '';
  }
  return mergeRequest.provider === 'github'
    ? `${mergeRequest.url}/checks`
    : `${mergeRequest.url}/pipelines`;
}

export function buildCompareUrl(remote: string, base: string, head: string): string {
  const webRoot = remoteWebRoot(remote);
  if (webRoot === '' || base === '' || head === '' || base === head) {
    return '';
  }
  return `${webRoot}${webViewPath(webRoot, 'compare')}${encodeBranchPath(base)}...${encodeBranchPath(head)}`;
}

export function humanAge(seconds: number | string): string {
  if (!isNonNegativeInt(seconds)) {
    return '?';
  }
  const value = Number(seconds);
  if (value >= 86400) {
    return `${Math.trunc(value / 86400)}d`;
  }
  if (value >= 3600) {
    return `${Math.trunc(value / 3600)}h`;
  }
  if (value >= 60) {
    return `${Math.trunc(value / 60)}m`;
  }
  return `${value}s`;
}

export function parseDefaultBranch(output: string): string {
  for (const line of output.split('\n')) {
    const [name = '', symbolicReference = ''] = line.split('\t');
    const target = symbolicReference === '' ? name : symbolicReference;
    if (target.startsWith('origin/') && target !== 'origin/HEAD') {
      return target.slice('origin/'.length);
    }
  }
  return '';
}

export function parsePorcelainV2(output: string): GitStatus {
  const status: GitStatus = {
    branch: '',
    hasUpstream: false,
    hasAheadBehind: false,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    conflicts: 0,
    untracked: 0,
  };
  const lines = output.split('\n');
  lines.pop();
  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      status.branch = line.slice('# branch.head '.length);
    } else if (line.startsWith('# branch.upstream ')) {
      status.hasUpstream = true;
    } else if (line.startsWith('# branch.ab ')) {
      status.hasAheadBehind = true;
      const fields = line.trim().split(/\s+/);
      status.ahead = numericPrefix((fields[2] ?? '').replace(/^\+/, ''));
      status.behind = numericPrefix((fields[3] ?? '').replace(/^-/, ''));
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.trim().split(/\s+/)[1] ?? '';
      if (xy.slice(0, 1) !== '.') {
        status.staged++;
      }
      if (xy.slice(1, 2) !== '.') {
        status.unstaged++;
      }
    } else if (line.startsWith('u ')) {
      status.conflicts++;
    } else if (line.startsWith('? ')) {
      status.untracked++;
    }
  }
  if (status.branch === '(detached)') {
    status.branch = 'detached';
  }
  return status;
}

export function parseWorktreePaths(output: string): WorktreePaths | undefined {
  const [commonDir = '', toplevel = ''] = output.split('\n').map((line) => line.trim());
  return commonDir === '' || toplevel === '' ? undefined : { commonDir, toplevel };
}

export function resolveProjectLocation(
  cwd: string,
  worktree: WorktreePaths | undefined,
): ProjectLocation {
  const plain: ProjectLocation = {
    projectName: basename(cwd),
    projectUrl: cwd === '' ? '' : `${toFileUrl(cwd)}/`,
    worktreeName: '',
    worktreeUrl: '',
    projectDir: cwd,
  };
  if (worktree === undefined) {
    return plain;
  }
  const mainProjectDir = path.dirname(worktree.commonDir);
  if (samePath(mainProjectDir, worktree.toplevel)) {
    return plain;
  }
  return {
    projectName: basename(mainProjectDir),
    projectUrl: `${toFileUrl(mainProjectDir)}/`,
    worktreeName: basename(worktree.toplevel),
    worktreeUrl: `${toFileUrl(worktree.toplevel)}/`,
    projectDir: mainProjectDir,
  };
}

export function timeUntil(value: string, now: number = nowSeconds()): string {
  if (value === '' || value === 'null') {
    return '';
  }
  let resetEpoch: number;
  if (/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    resetEpoch = Number(value.replace(/\.[^.]*$/, ''));
  } else {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return '';
    }
    resetEpoch = Math.floor(parsed / 1000);
  }
  const difference = resetEpoch - now;
  if (difference <= 0) {
    return '';
  }
  const days = Math.trunc(difference / 86400);
  const hours = Math.trunc((difference % 86400) / 3600);
  const minutes = Math.trunc((difference % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function toFileUrl(absolutePath: string): string {
  const forwardSlashed = absolutePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return `file:///${encodeURI(forwardSlashed).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}
