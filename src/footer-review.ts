import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { FooterRepository } from './pi-footer-data.js';
import type { FooterReview } from './pi-footer.js';

const executeFile = promisify(execFile);
const COMMAND_TIMEOUT_MS = 3000;

export interface FooterReviewCommandOptions {
  timeout: number;
}

export type FooterReviewCommand = (
  command: string,
  arguments_: readonly string[],
  options: FooterReviewCommandOptions,
) => Promise<{ stdout: string }>;

const executeReviewCommand: FooterReviewCommand = async (command, arguments_, options) => {
  const result = await executeFile(command, [...arguments_], {
    cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, timeout: options.timeout, maxBuffer: 64 * 1024,
  });
  return { stdout: result.stdout };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : undefined;
}

function repositoryTarget(repositoryUrl: string): { target: string; url: URL } | undefined {
  try {
    const url = new URL(repositoryUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    const projectPath = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!url.hostname || !projectPath) return undefined;
    return { target: `${url.host}/${projectPath}`, url };
  } catch {
    return undefined;
  }
}

function reviewUrl(value: unknown, repositoryUrl: URL, expectedPath: string): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.host !== repositoryUrl.host
      || parsed.pathname.replace(/\/$/, '') !== expectedPath
      || parsed.search || parsed.hash || parsed.username || parsed.password) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function parseReview(
  stdout: string,
  provider: 'github' | 'gitlab',
  repositoryUrl: URL,
  branch: string,
): FooterReview | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const first = record(parsed[0]);
  if (!first) return undefined;
  const number = provider === 'github' ? first.number : first.iid;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return undefined;
  const returnedBranch = provider === 'github' ? first.headRefName : first.source_branch;
  const returnedState = typeof first.state === 'string' ? first.state.toLowerCase() : undefined;
  if (returnedBranch !== branch || returnedState !== (provider === 'github' ? 'open' : 'opened')) return undefined;
  const repositoryPath = repositoryUrl.pathname.replace(/\/$/, '');
  const expectedPath = `${repositoryPath}${provider === 'github' ? '/pull/' : '/-/merge_requests/'}${number}`;
  const url = reviewUrl(provider === 'github' ? first.url : first.web_url, repositoryUrl, expectedPath);
  if (!url) return undefined;
  return {
    provider,
    number,
    url,
    ...(typeof first.title === 'string' && first.title.trim() ? { title: first.title } : {}),
  };
}

export async function discoverFooterReview(
  repository: FooterRepository,
  branch: string | null,
  command: FooterReviewCommand = executeReviewCommand,
): Promise<FooterReview | undefined> {
  if (!branch || !repository.reviewRepository) return undefined;
  const { provider, target, url } = repository.reviewRepository;
  const identity = repositoryTarget(url);
  if (!identity || identity.target !== target) return undefined;
  const invocation = provider === 'github'
    ? ['gh', ['pr', 'list', '--repo', identity.target, '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,title,url,headRefName,state']] as const
    : ['glab', ['mr', 'list', '--repo', url, '--source-branch', branch, '--output', 'json', '--per-page', '1']] as const;
  try {
    const result = await command(invocation[0], invocation[1], { timeout: COMMAND_TIMEOUT_MS });
    return parseReview(result.stdout, provider, identity.url, branch);
  } catch {
    return undefined;
  }
}
