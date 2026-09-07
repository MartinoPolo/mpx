#!/usr/bin/env node
/**
 * Deterministic base-branch detector.
 * Usage: node detect-base-branch.js [explicit-branch] [remote]
 *
 * Returns a single branch name to stdout. Existing candidates are scored by
 * fewest commits HEAD is ahead of their merge-base; priority order breaks ties:
 * dev > develop > main > master. Fallback: "main".
 */

import { execFileSync as defaultExecFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANDIDATE_BRANCHES = ['dev', 'develop', 'main', 'master'];

function gitExec(args, execFile) {
  try {
    return execFile('git', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function remoteBranchExists(branch, remote, execFile) {
  return gitExec(['rev-parse', '--verify', `refs/remotes/${remote}/${branch}`], execFile) !== null;
}

function commitsAhead(branch, remote, execFile) {
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const mergeBase = gitExec(['merge-base', remoteRef, 'HEAD'], execFile);
  if (mergeBase === null) return null;

  const count = gitExec(['rev-list', '--count', `${mergeBase}..HEAD`], execFile);
  if (count === null) return null;

  const parsed = Number.parseInt(count, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function detectBaseBranch(explicitBranch, options = {}) {
  const execFile = options.execFileSync || defaultExecFileSync;
  const remote = options.remote || 'origin';

  if (explicitBranch && remoteBranchExists(explicitBranch, remote, execFile)) {
    return explicitBranch;
  }

  let bestBranch = null;
  let bestCount = Infinity;
  for (const branch of CANDIDATE_BRANCHES) {
    if (!remoteBranchExists(branch, remote, execFile)) continue;
    const ahead = commitsAhead(branch, remote, execFile);
    if (ahead !== null && ahead < bestCount) {
      bestCount = ahead;
      bestBranch = branch;
    }
  }

  return bestBranch ?? 'main';
}

function main() {
  const explicitBranch = process.argv[2] || undefined;
  const remote = process.argv[3] || 'origin';
  process.stdout.write(`${detectBaseBranch(explicitBranch, { remote })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
