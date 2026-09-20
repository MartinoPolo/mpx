import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyResult } from './contracts.js';

const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_TIMEOUT_MS = 4_500;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTICS = 24;
const MAX_DIAGNOSTIC_LENGTH = 300;

type Severity = 'warn' | 'block';
type FindingType =
  | 'GitHub token'
  | 'Slack token'
  | 'private key'
  | 'AWS access-key ID'
  | 'generic secret assignment';

interface Finding {
  readonly severity: Severity;
  readonly type: FindingType;
  readonly path: string;
}

interface PrivateKeyCandidate {
  readonly label: string;
  bodyCharacters: number;
  bodyLines: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}

function excludedPath(filename: string): boolean {
  const normalized = filename.replaceAll('\\', '/');
  return [
    /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/iu,
    /\.env\.(?:example|sample|template)$/iu,
    /(?:^|\/)(?:[^/]+\.lock|[^/]*lock\.(?:json|ya?ml)|[^/]+\.lockb)$/iu,
  ].some((pattern) => pattern.test(normalized));
}

function safePath(filename: string): string {
  const safe = filename
    .replaceAll('\\', '/')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '?')
    .replace(/[^\x20-\x7e]/gu, '?')
    .replace(/(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,255})/gu, '[redacted]')
    .replace(/xox[baprs]-[A-Za-z0-9]{8,}(?:-[A-Za-z0-9]{8,}){1,3}/gu, '[redacted]')
    .replace(/AKIA[0-9A-Z]{16}/gu, '[redacted]')
    .replace(/\b(?:password|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token)\b\s*[:=].*/giu, '[credential-path-redacted]');
  if (safe.length <= 180) return safe;
  return `${safe.slice(0, 80)}...${safe.slice(-80)}`;
}

function decodeGitPath(raw: string): string | undefined {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"')) return undefined;
  const input = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== '\\') {
      bytes.push(...Buffer.from(character ?? '', 'utf8'));
      continue;
    }
    const escaped = input[++index];
    if (escaped === undefined) return undefined;
    const simple: Readonly<Record<string, number>> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      '\\': 92,
    };
    if (simple[escaped] !== undefined) {
      bytes.push(simple[escaped]);
      continue;
    }
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/u.test(input[index + 1] ?? '')) {
        octal += input[++index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

class StagedDiffParser {
  readonly findings: Finding[] = [];
  malformed = false;
  unreadable = false;
  private pending = '';
  private filename: string | undefined;
  private scanFile = false;
  private binaryFile = false;
  private hunkNewLines: number | undefined;
  private privateKey: PrivateKeyCandidate | undefined;
  private readonly findingKeys = new Set<string>();

  feed(text: string): void {
    if (text.includes('\uFFFD')) this.unreadable = true;
    this.pending += text;
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/u, '');
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
      newline = this.pending.indexOf('\n');
    }
  }

  finish(): void {
    if (this.pending.length > 0) this.line(this.pending.replace(/\r$/u, ''));
    this.pending = '';
    if (this.hunkNewLines !== undefined && this.hunkNewLines > 0) this.malformed = true;
  }

  private add(type: FindingType, severity: Severity): void {
    if (!this.filename) return;
    const path = safePath(this.filename);
    const key = `${severity}\0${type}\0${path}`;
    if (this.findingKeys.has(key)) return;
    this.findingKeys.add(key);
    this.findings.push({ severity, type, path });
  }

  private added(content: string): void {
    const github = /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,255})(?![A-Za-z0-9_])/u;
    const slack = /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9]{8,}(?:-[A-Za-z0-9]{8,}){1,3}(?![A-Za-z0-9-])/u;
    if (github.test(content)) this.add('GitHub token', 'block');
    if (slack.test(content)) this.add('Slack token', 'block');
    if (/(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/u.test(content)) {
      this.add('AWS access-key ID', 'warn');
    }
    if (
      /\b(?:password|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s#;,]{8,})/iu.test(content)
    ) {
      this.add('generic secret assignment', 'warn');
    }

    const header = content.match(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----/u);
    if (header?.[1]) {
      this.privateKey = { label: header[1], bodyCharacters: 0, bodyLines: 0 };
      return;
    }
    if (!this.privateKey) return;
    const trimmed = content.trim();
    if (trimmed === `-----END ${this.privateKey.label}-----`) {
      if (this.privateKey.bodyCharacters >= 40 && this.privateKey.bodyLines >= 1) {
        this.add('private key', 'block');
      }
      this.privateKey = undefined;
      return;
    }
    if (trimmed === '') return;
    if (/^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed)) {
      this.privateKey.bodyCharacters += trimmed.replace(/=/gu, '').length;
      this.privateKey.bodyLines += 1;
      // A substantial encoded body following the header is key material even when a
      // later truncation/failure prevents the closing marker from being observed.
      if (this.privateKey.bodyCharacters >= 40) this.add('private key', 'block');
    } else if (!/^(?:Proc-Type|DEK-Info):\s*[A-Za-z0-9,/_-]+$/u.test(trimmed)) {
      this.privateKey = undefined;
    }
  }

  private line(line: string): void {
    // Hunk content takes precedence over patch metadata: an added source line may itself begin `+++ `.
    if (this.hunkNewLines !== undefined && this.hunkNewLines > 0) {
      if (line.startsWith('+')) {
        if (this.scanFile) this.added(line.slice(1));
        this.hunkNewLines -= 1;
      } else if (line.startsWith(' ')) {
        this.privateKey = undefined;
        this.hunkNewLines -= 1;
      } else if (!line.startsWith('-') && !line.startsWith('\\ No newline at end of file')) {
        this.malformed = true;
        this.hunkNewLines = undefined;
      }
      if (this.hunkNewLines === 0) this.hunkNewLines = undefined;
      return;
    }
    if (line.startsWith('diff --git ')) {
      if (this.hunkNewLines !== undefined && this.hunkNewLines > 0) this.malformed = true;
      this.filename = undefined;
      this.scanFile = false;
      this.binaryFile = false;
      this.hunkNewLines = undefined;
      this.privateKey = undefined;
      return;
    }
    if (line.startsWith('+++ ')) {
      const decoded = decodeGitPath(line.slice(4));
      if (!decoded) {
        this.malformed = true;
        this.filename = undefined;
        this.scanFile = false;
        return;
      }
      const filename = decoded === '/dev/null' ? undefined : decoded.replace(/^b\//u, '');
      if (filename && filename.length > 4_096) {
        this.malformed = true;
        this.filename = undefined;
        this.scanFile = false;
        return;
      }
      this.filename = filename;
      this.scanFile = Boolean(filename && !excludedPath(filename));
      this.privateKey = undefined;
      return;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      this.binaryFile = true;
      this.scanFile = false;
      this.privateKey = undefined;
      return;
    }
    if (line.startsWith('@@')) {
      this.privateKey = undefined;
      const match = line.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,(\d+))? @@/u);
      if (!match || !this.filename || this.binaryFile) {
        if (!this.binaryFile) this.malformed = true;
        this.hunkNewLines = undefined;
        return;
      }
      this.hunkNewLines = match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
      return;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) this.malformed = true;
  }
}

function resultFrom(parser: StagedDiffParser, infrastructure: readonly string[] = []): PolicyResult {
  const findingDiagnostic = (finding: Finding): string => {
    const prefix = finding.severity === 'block' ? 'Blocked' : 'Warning:';
    return `${prefix} staged ${finding.type} in ${finding.path}.`;
  };
  const blocking = parser.findings
    .filter((finding) => finding.severity === 'block')
    .map(findingDiagnostic);
  const warnings = parser.findings
    .filter((finding) => finding.severity === 'warn')
    .map(findingDiagnostic);
  const incomplete = new Set(infrastructure);
  if (parser.unreadable) incomplete.add('diff was unreadable');
  if (parser.malformed) incomplete.add('diff was malformed');
  const failures = [...incomplete].map((reason) => `Staged-secret scan incomplete: ${reason}.`);

  const ordered = [...new Set([...blocking, ...failures, ...warnings])];
  const diagnostics = ordered.length <= MAX_DIAGNOSTICS
    ? ordered
    : [
        ...ordered.slice(0, MAX_DIAGNOSTICS - 1),
        `${ordered.length - (MAX_DIAGNOSTICS - 1)} additional diagnostics omitted.`,
      ];
  const bounded = diagnostics.map((diagnostic) => diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH));
  if (blocking.length > 0) return { decision: 'block', diagnostics: bounded };
  if (warnings.length > 0 || incomplete.size > 0) return { decision: 'warn', diagnostics: bounded };
  return { decision: 'allow', diagnostics: [] };
}

/** Pure parser for aggregate `git diff --cached --unified=0` output. */
export function scanStagedDiff(diff: string): PolicyResult {
  const parser = new StagedDiffParser();
  parser.feed(diff);
  parser.finish();
  return resultFrom(parser);
}

/** Scan added lines in one bounded aggregate staged diff. Runtime transports are intentionally separate. */
export async function scanStagedSecrets(
  cwd: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<PolicyResult> {
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = Math.max(1, boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES));
  const parser = new StagedDiffParser();
  const decoder = new StringDecoder('utf8');
  const started = Date.now();

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'git',
        [
          '-C', resolvePath(cwd),
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--unified=0',
          '--no-color',
          '--no-relative',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--diff-filter=ACMR',
          '--',
        ],
        {
          // Windows executable lookup searches cwd before PATH. Resolve Git from
          // this trusted helper directory, never from the inspected repository.
          cwd: fileURLToPath(new URL('.', import.meta.url)),
          env: { ...process.env, GIT_DIFF_OPTS: '' },
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch {
      resolve(resultFrom(parser, ['Git process failed']));
      return;
    }

    let bytes = 0;
    let settled = false;
    let stoppingReason: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let killFallback: NodeJS.Timeout | undefined;
    const complete = (reason?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killFallback) clearTimeout(killFallback);
      parser.feed(decoder.end());
      parser.finish();
      resolve(resultFrom(parser, reason ? [reason] : []));
    };
    const stop = (reason: string): void => {
      if (settled || stoppingReason) return;
      stoppingReason = reason;
      if (timer) clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stdout?.destroy();
      child.kill();
      // Normally `close` follows immediately. Preserve a hard sub-five-second return budget
      // even if an unusual platform process cannot report closure after termination.
      killFallback = setTimeout(() => complete(reason), 250);
      killFallback.unref();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      const remaining = maxBytes - bytes;
      if (remaining > 0) parser.feed(decoder.write(chunk.subarray(0, remaining)));
      bytes += chunk.length;
      if (bytes > maxBytes) stop('diff exceeded the size limit');
    });
    child.stdout?.on('error', () => stop('diff was unreadable'));
    child.once('error', () => complete(stoppingReason ?? 'Git process failed'));
    child.once('close', (code) =>
      complete(stoppingReason ?? (code === 0 ? undefined : 'Git process failed')),
    );

    const remainingTime = Math.max(0, timeoutMs - (Date.now() - started));
    if (remainingTime === 0) {
      stop('scan timed out');
    } else {
      timer = setTimeout(() => stop('scan timed out'), remainingTime);
      timer.unref();
    }
  });
}
