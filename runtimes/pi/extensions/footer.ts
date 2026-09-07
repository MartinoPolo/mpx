/**
 * MPX's Pi footer status line.
 *
 * Pi calls `render(width)` in-process, so every shell-out, file read and network
 * call happens in a background refresher that only updates a snapshot.
 * `render(width)` remains pure formatting and never blocks.
 *
 * Parsing and formatting logic lives in package-local helpers. The footer
 * re-expresses only colour-bearing rendering so theme changes apply immediately.
 *
 * Rows 9-11 (MR/PR + CI block, dev-server port probes, subagent Σ tally) were
 * added in part 2. Rows 9 and 10 hang off the location row the way the Claude
 * bar composes them; row 11 is a builder of its own, fed by the vendored
 * subagents fork's `pi.events` lifecycle events. The fork's own above-editor
 * widget owns the *live* per-agent view — see extensions/subagents/VENDORED.md.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { connect as connectTls } from 'node:tls';
import { promisify } from 'node:util';

import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { hyperlink as osc8Hyperlink, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import {
  formatManagedDevServer,
  subscribeManagedDevServerEvents,
  type ManagedFooterSnapshot,
  type ManagedFooterTone,
} from './dev-server/footer-format.js';

import { COMPACTION_ROWS, formatClock, formatTokensK } from './lib/compaction.js';
import { resolvePiCodingAgentDir } from './lib/agent-directory.js';
import { RESET, isNonNegativeInt } from './lib/statusline-ansi.js';
import {
  AGENT_DETAIL_ROWS,
  AGENT_TYPE_ROWS,
  COMPLETED,
  countLabel,
  formatDuration,
  formatTokens,
  groupMembers,
  selectDetailRows,
} from './lib/subagent-history.js';
import {
  INDENT_GUARD,
  type GitStatus,
  type MrFields,
  type ProjectLocation,
  type WorktreePaths,
  buildBranchUrl,
  buildCiUrl,
  humanAge,
  parsePorcelainV2,
  parseWorktreePaths,
  resolveProjectLocation,
  timeUntil,
  toFileUrl,
} from './lib/status-line.js';

const runCommand = promisify(execFile);

// --- Palette -----------------------------------------------------------------

/**
 * The footer's colour vocabulary, resolved from pi's theme so a `/theme` switch
 * recolours the bar. Two hues have no semantic slot in pi's `ThemeColor` union —
 * the context bar's middle escalation step and the "never left this machine"
 * sand — so those keep the xterm-256 fallbacks the Claude bar used before it
 * became scheme-derived.
 */
export interface FooterPalette {
  reset: string;
  /** Brightest foreground: reserved for the one field answering "where am I". */
  text: string;
  /** Default reading weight. */
  gray: string;
  /** One step back: facts that are context rather than signal. */
  dim: string;
  /** Unfilled bar cells. */
  barEmpty: string;
  accent: string;
  /** A state you have to act on. */
  warn: string;
  /** A fact you did not choose and would want to catch. */
  amber: string;
  contextYellow: string;
  contextOrange: string;
  contextRed: string;
  add: string;
  del: string;
  /** Session title — the one field allowed weight as well as hue. */
  session: string;
  /** Local-only: a branch that never left this machine. */
  local: string;
  /** Reserved for the MR/PR reference in row 9. */
  mr: string;
}

/** Minimal shape of pi's `Theme` this file needs; keeps the renderer mockable. */
export interface FooterTheme {
  getFgAnsi(color: string): string;
  bold?(text: string): string;
}

/** 256-colour foreground escape, for the two hues pi's theme has no slot for. */
function ansi256(code: number): string {
  return `\x1b[38;5;${code}m`;
}

const BOLD = '\x1b[1m';

/** `getFgAnsi` throws on an unknown colour, so every lookup carries a fallback. */
function themeColor(theme: FooterTheme, color: string, fallback: string): string {
  try {
    const ansi = theme.getFgAnsi(color);
    return ansi === '' ? fallback : ansi;
  } catch {
    return fallback;
  }
}

export function resolveFooterPalette(theme: FooterTheme): FooterPalette {
  const gray = themeColor(theme, 'muted', ansi256(245));
  return {
    reset: RESET,
    text: themeColor(theme, 'text', ansi256(255)),
    gray,
    dim: themeColor(theme, 'dim', ansi256(240)),
    barEmpty: themeColor(theme, 'borderMuted', ansi256(236)),
    accent: themeColor(theme, 'accent', ansi256(39)),
    warn: themeColor(theme, 'error', ansi256(203)),
    amber: themeColor(theme, 'warning', ansi256(179)),
    contextYellow: themeColor(theme, 'warning', ansi256(179)),
    contextOrange: ansi256(208),
    contextRed: themeColor(theme, 'error', ansi256(203)),
    add: themeColor(theme, 'success', ansi256(114)),
    del: themeColor(theme, 'error', ansi256(203)),
    session: BOLD + themeColor(theme, 'mdHeading', ansi256(176)),
    local: ansi256(180),
    mr: themeColor(theme, 'mdLink', ansi256(75)),
  };
}

// --- Glyphs and shared render primitives -------------------------------------

/**
 * Git branch glyph (U+E725, Nerd Font devicons) — the one Private Use Area
 * codepoint on the bar, licensed by the `Cascadia Mono, Symbols Nerd Font`
 * fallback pair documented for the original status line. Every other
 * glyph below is present in plain Cascadia Mono's cmap.
 */
const BRANCH_ICON = '\ue725';

/**
 * Pencil (U+F03EB, Nerd Font Material Design set) - the edit-this-config click
 * target beside the dev-server ports. Double-width in the Symbols Nerd Font
 * fallback, so it always keeps a plain space behind it.
 */
const PENCIL_ICON = '\u{f03eb}';

/** The one field separator, at every level: `next field`. */
function separator(palette: FooterPalette): string {
  return ` ${palette.gray}\u00b7${palette.reset} `;
}

/** Joins pre-coloured segments, dropping empties so no separator dangles. */
export function joinSegments(segments: string[], palette: FooterPalette): string {
  return segments.filter((segment) => segment !== '').join(separator(palette));
}

/**
 * OSC-8 link via pi-tui's public helper, which pi's own line wrapper knows how
 * to re-open across wrapped physical lines. Argument order is pi-tui's
 * (text, url), the reverse of the mpx `hyperlink(url, label)`.
 */
export function link(label: string, url: string): string {
  return url === '' ? label : osc8Hyperlink(label, url);
}

export function renderProgressBar(
  percent: number,
  width: number,
  filled: string,
  palette: FooterPalette,
): string {
  const clamped = Math.max(0, Math.min(100, percent));
  // Use the nearest cell: flooring made 12% of an eight-cell quota bar look empty.
  const cells = Math.round((clamped * width) / 100);
  let out = '';
  for (let index = 0; index < width; index++) {
    out +=
      index < cells
        ? `${filled}\u2588${palette.reset}`
        : `${palette.barEmpty}\u2591${palette.reset}`;
  }
  return out;
}

/** `1234` -> `1.2k`, `1234567` -> `1.2M`. Compact enough for a token column. */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return '0';
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(Math.trunc(tokens));
}

// --- Row 1: thinking gauge ---------------------------------------------------

export const THINKING_GAUGE_SLOTS = 6;

/**
 * pi has seven thinking levels: `off` plus six increasing effort levels. Six
 * slots give every enabled level its own whole-diamond rank while `off` remains
 * an empty gauge.
 */
const THINKING_RANK_BY_LEVEL: Readonly<Record<string, number>> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** `medium` -> `◆◆◆◇◇◇`; an unrecognised level keeps the `<level>` spelling. */
export function thinkingGauge(level: string): string {
  const rank = THINKING_RANK_BY_LEVEL[level];
  if (rank === undefined) {
    return level === '' ? '' : `<${level}>`;
  }
  return '\u25c6'.repeat(rank) + '\u25c7'.repeat(THINKING_GAUGE_SLOTS - rank);
}

// --- Settings ----------------------------------------------------------------

export interface FooterSessionIdentity {
  runtimeLabel: 'mpx-pi' | 'pi' | 'piw';
  identity: string;
  mode: string;
}

type FooterEnvironment = Readonly<Record<string, string | undefined>>;

const SAFE_IDENTITY_FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function resolveFooterSessionIdentity(
  environment: FooterEnvironment = process.env,
): FooterSessionIdentity {
  if (environment.MPX_RUNTIME === 'pi') {
    const identity = environment.MPX_IDENTITY ?? '';
    const mode = environment.MPX_MODE ?? '';
    return {
      runtimeLabel: 'mpx-pi',
      identity: SAFE_IDENTITY_FIELD.test(identity) ? identity : '',
      mode: SAFE_IDENTITY_FIELD.test(mode) ? mode : '',
    };
  }

  const accountRoot = environment.PI_CODING_AGENT_DIR?.trim() ?? '';
  return {
    runtimeLabel:
      path.basename(path.normalize(accountRoot)).toLowerCase() === 'agent-work' ? 'piw' : 'pi',
    identity: '',
    mode: '',
  };
}

export interface CompactionSettingsSnapshot {
  enabled: boolean;
  reserveTokens: number;
  defaultThinkingLevel: string;
}

/** pi's documented defaults (docs/compaction.md), pinned so a change is visible. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettingsSnapshot = {
  enabled: true,
  reserveTokens: 16384,
  defaultThinkingLevel: '',
};

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\ufeff/, '');
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Project settings win over global, matching pi's own resolution order. */
export function readCompactionSettings(agentDir: string, cwd: string): CompactionSettingsSnapshot {
  const merged = { ...DEFAULT_COMPACTION_SETTINGS };
  for (const file of [
    path.join(agentDir, 'settings.json'),
    path.join(cwd, '.pi', 'settings.json'),
  ]) {
    const settings = readJsonFile(file);
    if (settings === undefined) {
      continue;
    }
    if (typeof settings.defaultThinkingLevel === 'string') {
      merged.defaultThinkingLevel = settings.defaultThinkingLevel;
    }
    const compaction = settings.compaction;
    if (compaction === null || typeof compaction !== 'object') {
      continue;
    }
    const block = compaction as Record<string, unknown>;
    if (typeof block.enabled === 'boolean') {
      merged.enabled = block.enabled;
    }
    if (isNonNegativeInt(block.reserveTokens)) {
      merged.reserveTokens = Number(block.reserveTokens);
    }
  }
  return merged;
}

/**
 * The token count at which pi compacts: `contextTokens > contextWindow -
 * reserveTokens` (docs/compaction.md). 0 when compaction is off, which renders
 * no bar — nothing happens at the window edge, so a bar creeping toward it
 * would measure a threshold nobody acts on.
 */
export function compactionTriggerTokens(
  contextWindow: number,
  settings: CompactionSettingsSnapshot,
): number {
  if (!settings.enabled || contextWindow <= 0) {
    return 0;
  }
  return Math.max(0, contextWindow - settings.reserveTokens);
}

// --- Session digest (cost, tokens, compactions) ------------------------------

export interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export const EMPTY_SESSION_USAGE: SessionUsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
};

/** Session-wide totals, summed over the assistant messages on the active branch. */
export function collectSessionUsage(
  entries: readonly { type: string; message?: unknown }[],
): SessionUsageTotals {
  const totals: SessionUsageTotals = { ...EMPTY_SESSION_USAGE };
  for (const entry of entries) {
    if (entry.type !== 'message') {
      continue;
    }
    const message = entry.message as AssistantMessage | undefined;
    if (message === undefined || message.role !== 'assistant' || message.usage === undefined) {
      continue;
    }
    totals.input += message.usage.input ?? 0;
    totals.output += message.usage.output ?? 0;
    totals.cacheRead += message.usage.cacheRead ?? 0;
    totals.cacheWrite += message.usage.cacheWrite ?? 0;
    totals.costUsd += message.usage.cost?.total ?? 0;
  }
  return totals;
}

export interface FooterCompactionEvent {
  /**
   * pi's own vocabulary — `manual`, `threshold`, `overflow` — carried from the
   * `session_compact` event. Empty for a compaction replayed from a resumed
   * session file, where the reason was never persisted.
   */
  reason: string;
  tokensBefore: number;
  timestamp: string;
}

/**
 * Compactions on the active branch, oldest first.
 *
 * Claude Code's renderer read `compact_boundary` lines out of the transcript
 * `.jsonl` with a byte-offset cache, because it was a fresh process on every
 * tick. pi hands the same records over in-process as `CompactionEntry` nodes, so
 * the whole incremental-scan machinery in `lib/compaction.mts` is unused here —
 * only its formatters are.
 */
export function compactionEventsFromEntries(
  entries: readonly { type: string; id?: string; timestamp?: string; tokensBefore?: number }[],
  reasonByEntryId: ReadonlyMap<string, string>,
): FooterCompactionEvent[] {
  const events: FooterCompactionEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== 'compaction') {
      continue;
    }
    events.push({
      reason: reasonByEntryId.get(entry.id ?? '') ?? '',
      tokensBefore: typeof entry.tokensBefore === 'number' ? entry.tokensBefore : 0,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
    });
  }
  return events;
}

// --- Git ---------------------------------------------------------------------

export interface GitSnapshot {
  status: GitStatus;
  worktree: WorktreePaths | undefined;
  branchUrl: string;
}

const GIT_TIMEOUT_MS = 3_000;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await runCommand('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * One porcelain-v2 call carries the branch and the worktree paths plus remote
 * URL provide the two footer links. All process work stays off the render path.
 */
export async function readGitSnapshot(cwd: string): Promise<GitSnapshot | undefined> {
  if (cwd === '') {
    return undefined;
  }
  const porcelain = await git(cwd, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=normal',
  ]);
  if (porcelain === '') {
    return undefined;
  }
  const status = parsePorcelainV2(porcelain);
  if (status.branch === '') {
    return undefined;
  }

  const worktree = parseWorktreePaths(
    await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']),
  );

  const remote = (await git(cwd, ['remote', 'get-url', 'origin'])).trim();
  return {
    status,
    worktree,
    branchUrl: remote === '' ? '' : buildBranchUrl(remote, status.branch),
  };
}

// --- Codex quota -------------------------------------------------------------

export interface CodexQuotaWindow {
  usedPercent: number;
  windowMinutes: number | undefined;
  resetAtEpochSeconds: number | undefined;
}

export interface CodexQuota {
  primary: CodexQuotaWindow | undefined;
  secondary: CodexQuotaWindow | undefined;
  planType: string | undefined;
  source: 'headers' | 'usage-api';
  observedAtEpochSeconds: number;
}

export const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_PROVIDER = 'openai-codex';

/** JWT claim the ChatGPT account id hides under, per pi-ai's own codex API layer. */
const CODEX_JWT_CLAIM_PATH = 'https://api.openai.com/auth';

/** Quota older than this gets a muted age note beside it. */
const QUOTA_STALE_SECONDS = 900;

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
}

function headerNumber(headers: Record<string, string>, name: string): number | undefined {
  const raw = headerValue(headers, name);
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Quota carried on an ordinary Codex response. Free — pi already made the call —
 * so this is the primary source; the endpoint poll corrects lagging headers once
 * a minute. Header names verified against `mtrojnar/pi-usage`'s `src/codex.ts`.
 */
export function parseCodexQuotaHeaders(
  headers: Record<string, string>,
  nowSeconds: number,
): CodexQuota | undefined {
  const buildWindow = (prefix: string): CodexQuotaWindow | undefined => {
    const usedPercent = headerNumber(headers, `x-codex-${prefix}-used-percent`);
    if (usedPercent === undefined) {
      return undefined;
    }
    const resetAt = headerNumber(headers, `x-codex-${prefix}-reset-at`);
    const resetAfter = headerNumber(headers, `x-codex-${prefix}-reset-after-seconds`);
    return {
      usedPercent,
      windowMinutes: headerNumber(headers, `x-codex-${prefix}-window-minutes`),
      resetAtEpochSeconds:
        resetAt !== undefined && resetAt > 0
          ? Math.trunc(resetAt > 1e12 ? resetAt / 1000 : resetAt)
          : resetAfter !== undefined
            ? nowSeconds + Math.trunc(resetAfter)
            : undefined,
    };
  };
  const primary = buildWindow('primary');
  const secondary = buildWindow('secondary');
  if (primary === undefined && secondary === undefined) {
    return undefined;
  }
  return {
    primary,
    secondary,
    planType: headerValue(headers, 'x-codex-plan-type'),
    source: 'headers',
    observedAtEpochSeconds: nowSeconds,
  };
}

/**
 * `GET /backend-api/wham/usage` — the same endpoint `carlosarraes/pi-codex-status`
 * and `mtrojnar/pi-usage` read, which returns plan plus both windows without
 * spending a model request.
 */
export function parseCodexUsageResponse(body: unknown, nowSeconds: number): CodexQuota | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const rateLimit = record.rate_limit;
  if (rateLimit === null || typeof rateLimit !== 'object') {
    return undefined;
  }
  const buildWindow = (raw: unknown): CodexQuotaWindow | undefined => {
    if (raw === null || typeof raw !== 'object') {
      return undefined;
    }
    const window = raw as Record<string, unknown>;
    if (typeof window.used_percent !== 'number') {
      return undefined;
    }
    const windowSeconds =
      typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds : undefined;
    const resetAt = typeof window.reset_at === 'number' ? window.reset_at : undefined;
    const resetAfter =
      typeof window.reset_after_seconds === 'number' ? window.reset_after_seconds : undefined;
    return {
      usedPercent: window.used_percent,
      windowMinutes: windowSeconds === undefined ? undefined : Math.round(windowSeconds / 60),
      resetAtEpochSeconds:
        resetAt !== undefined && resetAt > 0
          ? Math.trunc(resetAt)
          : resetAfter !== undefined
            ? nowSeconds + Math.trunc(resetAfter)
            : undefined,
    };
  };
  const limits = rateLimit as Record<string, unknown>;
  const primary = buildWindow(limits.primary_window);
  const secondary = buildWindow(limits.secondary_window);
  if (primary === undefined && secondary === undefined) {
    return undefined;
  }
  return {
    primary,
    secondary,
    planType: typeof record.plan_type === 'string' ? record.plan_type : undefined,
    source: 'usage-api',
    observedAtEpochSeconds: nowSeconds,
  };
}

/** `300` -> `5h`, `10080` -> `7d`. The label is the window, not a guess. */
export function formatQuotaWindowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return fallback;
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${Math.round(minutes)}m`;
}

/** The ChatGPT account id the usage endpoint scopes to, decoded from the bearer. */
export function accountIdFromBearerToken(token: string): string | undefined {
  try {
    const payload = token.split('.')[1];
    if (payload === undefined) {
      return undefined;
    }
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    const auth = claims[CODEX_JWT_CLAIM_PATH];
    if (auth === null || typeof auth !== 'object') {
      return undefined;
    }
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === 'string' && accountId !== '' ? accountId : undefined;
  } catch {
    return undefined;
  }
}

// --- Row 9: MR/PR + CI -------------------------------------------------------

/**
 * In-process merge-request refresh for the Pi footer.
 *
 * The Claude bar had to spawn that script detached and read its `$TMPDIR` cache
 * back on the next tick, because a status line that blocks gets cancelled. pi
 * renders in-process, so the same `gh` / `glab` calls run here on a timer and
 * the result is an in-memory snapshot: no cache file, no detached child, no
 * atomic-write dance. The field contract is unchanged - `MrFields` is imported
 * from the Claude renderer so the two agree on what a field means, and
 * `buildCiUrl` is shared outright.
 */

/** Refetch past this. `MR_TTL` in the Claude renderer. */
const MERGE_REQUEST_TTL_SECONDS = 90;
/** Floor between attempts, failures and "no open PR" included. `MR_ATTEMPT_MIN`. */
const MERGE_REQUEST_ATTEMPT_FLOOR_SECONDS = 30;
/** Past this the block carries a muted age note. `MR_STALE_NOTE`. */
const MERGE_REQUEST_STALE_NOTE_SECONDS = 600;
/** Same 10 s cap the shell script gave `timeout`. */
const MERGE_REQUEST_TIMEOUT_MS = 10_000;

export const EMPTY_MERGE_REQUEST: MrFields = {
  timestamp: '',
  provider: '',
  iid: '',
  draft: '',
  conflicts: '',
  approved: '',
  approvalsRequired: '',
  approvalsLeft: '',
  status: '',
  notes: '',
  pipeline: '',
  url: '',
  fetchEpoch: '',
};

export interface RemoteIdentity {
  host: string;
  /** `owner/repo` on GitHub, the full path on GitLab. */
  project: string;
}

/**
 * Host and project out of an `origin` URL, for the three forms git writes:
 * `git@host:path`, `ssh://[user@]host[:port]/path`, `http(s)://[user@]host/path`.
 */
export function parseRemoteIdentity(remoteUrl: string): RemoteIdentity | undefined {
  const url = remoteUrl.trim();
  let host = '';
  let projectPath = '';
  if (url.startsWith('git@')) {
    const withoutUser = url.slice('git@'.length);
    host = withoutUser.split(':')[0] ?? '';
    projectPath = withoutUser.slice(host.length + 1);
  } else if (url.startsWith('ssh://')) {
    const authorityAndPath = url.slice('ssh://'.length).split('@').pop() ?? '';
    const slash = authorityAndPath.indexOf('/');
    if (slash === -1) {
      return undefined;
    }
    host = (authorityAndPath.slice(0, slash).split(':')[0] ?? '').trim();
    projectPath = authorityAndPath.slice(slash + 1);
  } else if (url.startsWith('https://') || url.startsWith('http://')) {
    const authorityAndPath =
      url
        .slice(url.indexOf('://') + 3)
        .split('@')
        .pop() ?? '';
    const slash = authorityAndPath.indexOf('/');
    if (slash === -1) {
      return undefined;
    }
    host = authorityAndPath.slice(0, slash);
    projectPath = authorityAndPath.slice(slash + 1);
  } else {
    return undefined;
  }
  const project = projectPath.replace(/\.git$/, '');
  if (host === '' || project === '') {
    return undefined;
  }
  return { host, project };
}

/** Only the two hosts either CLI can talk to; anything else leaves row 9 absent. */
export function providerForHost(host: string): 'github' | 'gitlab' | '' {
  const lower = host.toLowerCase();
  if (lower.includes('gitlab')) {
    return 'gitlab';
  }
  if (lower.includes('github')) {
    return 'github';
  }
  return '';
}

function jsonField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * GitHub reports one entry per check: check-runs carry `conclusion` with a null
 * `state`, legacy commit statuses only `state`. One failure anywhere fails the
 * whole rollup, an incomplete check keeps it running, and an empty rollup means
 * the branch has no CI rather than a passing one.
 */
export function rollupCheckState(checks: readonly unknown[]): string {
  if (checks.length === 0) {
    return '';
  }
  const states = checks.map((check) =>
    String(jsonField(check, 'conclusion') ?? jsonField(check, 'state') ?? '').toUpperCase(),
  );
  const failed = ['FAILURE', 'FAILED', 'TIMED_OUT', 'ERROR', 'CANCELLED'];
  if (states.some((state) => failed.includes(state))) {
    return 'FAILED';
  }
  const incomplete = checks.some((check) => {
    const status = jsonField(check, 'status');
    return status !== null && status !== undefined && String(status).toUpperCase() !== 'COMPLETED';
  });
  return incomplete ? 'RUNNING' : 'SUCCESS';
}

/** GitLab spells five extra pipeline states that all mean "not finished yet". */
export function normalizeGitlabPipelineState(raw: string): string {
  const state = raw.toUpperCase();
  if (['PENDING', 'CREATED', 'WAITING_FOR_RESOURCE', 'PREPARING'].includes(state)) {
    return 'RUNNING';
  }
  return ['SUCCESS', 'FAILED', 'RUNNING', 'CANCELED', 'SKIPPED'].includes(state) ? state : '';
}

/** `gh pr list --json ...` output to the shared field contract. */
export function reduceGithubPullRequest(
  payload: unknown,
  observedAtEpochSeconds: number,
): MrFields {
  const base: MrFields = {
    ...EMPTY_MERGE_REQUEST,
    timestamp: String(observedAtEpochSeconds),
    provider: 'github',
    approvalsRequired: '0',
    approvalsLeft: '0',
    notes: '0',
  };
  const pullRequest = Array.isArray(payload) ? payload[0] : undefined;
  if (pullRequest === undefined || pullRequest === null) {
    return base;
  }
  const mergeable = String(jsonField(pullRequest, 'mergeable') ?? '');
  const reviewDecision = String(jsonField(pullRequest, 'reviewDecision') ?? '');
  const comments = jsonField(pullRequest, 'comments');
  const checks = jsonField(pullRequest, 'statusCheckRollup');
  return {
    ...base,
    iid: String(jsonField(pullRequest, 'number') ?? ''),
    draft: String(jsonField(pullRequest, 'isDraft') === true),
    conflicts: String(mergeable === 'CONFLICTING'),
    approved: String(reviewDecision === 'APPROVED'),
    status: reviewDecision === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : mergeable,
    notes: String(Array.isArray(comments) ? comments.length : 0),
    pipeline: rollupCheckState(Array.isArray(checks) ? checks : []),
    url: String(jsonField(pullRequest, 'url') ?? ''),
  };
}

/** `glab api graphql` output to the shared field contract. */
export function reduceGitlabMergeRequest(
  payload: unknown,
  observedAtEpochSeconds: number,
): MrFields {
  const base: MrFields = {
    ...EMPTY_MERGE_REQUEST,
    timestamp: String(observedAtEpochSeconds),
    provider: 'gitlab',
    approvalsRequired: '0',
    approvalsLeft: '0',
    notes: '0',
  };
  const project = jsonField(jsonField(payload, 'data'), 'project');
  if (project === undefined || project === null) {
    return base;
  }
  const nodes = jsonField(jsonField(project, 'mergeRequests'), 'nodes');
  const mergeRequest = Array.isArray(nodes) ? nodes[0] : undefined;
  if (mergeRequest === undefined || mergeRequest === null) {
    return base;
  }
  const pipeline = String(jsonField(jsonField(mergeRequest, 'headPipeline'), 'status') ?? '');
  return {
    ...base,
    iid: String(jsonField(mergeRequest, 'iid') ?? ''),
    draft: String(jsonField(mergeRequest, 'draft') === true),
    conflicts: String(jsonField(mergeRequest, 'conflicts') === true),
    approved: String(jsonField(mergeRequest, 'approved') === true),
    approvalsRequired: '0',
    approvalsLeft: '0',
    status: String(jsonField(mergeRequest, 'detailedMergeStatus') ?? ''),
    notes: String(jsonField(mergeRequest, 'userNotesCount') ?? 0),
    pipeline: normalizeGitlabPipelineState(pipeline),
    url: String(jsonField(mergeRequest, 'webUrl') ?? ''),
  };
}

// approvalsRequired/approvalsLeft are GitLab Premium fields; a self-hosted CE host
// (e.g. gitlab.verotel.cz) rejects the whole query with `undefinedField`. Dropped for
// cross-edition compatibility — approvalsRequired/approvalsLeft are pinned to "0" above.
const GITLAB_MERGE_REQUEST_QUERY =
  'query($p:ID!,$b:[String!]){project(fullPath:$p){mergeRequests(state:opened,sourceBranches:$b){nodes{' +
  'iid draft conflicts approved detailedMergeStatus ' +
  'userNotesCount webUrl headPipeline{status} }}}}';

/**
 * One provider call. Every failure path - no remote, an unsupported host, a CLI
 * that is not installed or not authenticated, a malformed response - returns
 * undefined, and an undefined snapshot renders nothing at all.
 */
export async function readMergeRequest(cwd: string, branch: string): Promise<MrFields | undefined> {
  if (cwd === '' || branch === '') {
    return undefined;
  }
  const remote = (await git(cwd, ['remote', 'get-url', 'origin'])).trim();
  const identity = remote === '' ? undefined : parseRemoteIdentity(remote);
  if (identity === undefined) {
    return undefined;
  }
  const provider = providerForHost(identity.host);
  if (provider === '') {
    return undefined;
  }

  const observedAt = nowSeconds();
  try {
    if (provider === 'github') {
      const { stdout } = await runCommand(
        'gh',
        [
          'pr',
          'list',
          '-R',
          identity.project,
          '--head',
          branch,
          '--state',
          'open',
          '--limit',
          '1',
          '--json',
          'number,isDraft,mergeable,reviewDecision,statusCheckRollup,url,comments',
        ],
        { encoding: 'utf8', timeout: MERGE_REQUEST_TIMEOUT_MS, windowsHide: true },
      );
      return stdout.trim() === ''
        ? undefined
        : reduceGithubPullRequest(JSON.parse(stdout), observedAt);
    }
    const { stdout } = await runCommand(
      'glab',
      [
        'api',
        'graphql',
        '-f',
        `query=${GITLAB_MERGE_REQUEST_QUERY}`,
        '-f',
        `p=${identity.project}`,
        '-f',
        `b=${branch}`,
      ],
      {
        encoding: 'utf8',
        timeout: MERGE_REQUEST_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GITLAB_HOST: identity.host },
      },
    );
    return stdout.trim() === ''
      ? undefined
      : reduceGitlabMergeRequest(JSON.parse(stdout), observedAt);
  } catch {
    return undefined;
  }
}

/** Pipeline state to the label and palette slot the block draws for it. */
const CI_STATE_BY_PIPELINE: Readonly<Record<string, { text: string; tone: keyof FooterPalette }>> =
  {
    SUCCESS: { text: 'ci ok', tone: 'add' },
    FAILED: { text: 'ci fail', tone: 'warn' },
    RUNNING: { text: 'ci run', tone: 'contextYellow' },
    CANCELED: { text: 'ci skip', tone: 'gray' },
    SKIPPED: { text: 'ci skip', tone: 'gray' },
  };

/**
 * The one review state worth showing, or "". Mutually exclusive by construction,
 * in the Claude renderer's precedence: a draft's conflicts and approvals are
 * noise until it is marked ready.
 */
export function buildMergeRequestState(mergeRequest: MrFields, palette: FooterPalette): string {
  if (mergeRequest.draft === 'true') {
    return `${palette.local}draft${palette.reset}`;
  }
  if (mergeRequest.conflicts === 'true') {
    return `${palette.warn}conflicts${palette.reset}`;
  }
  if (mergeRequest.status === 'CHANGES_REQUESTED') {
    return `${palette.warn}changes-req${palette.reset}`;
  }
  if (mergeRequest.approved === 'true') {
    return `${palette.add}approved${palette.reset}`;
  }
  if (isNonNegativeInt(mergeRequest.approvalsLeft) && Number(mergeRequest.approvalsLeft) > 0) {
    return `${palette.gray}${mergeRequest.approvalsLeft}/${mergeRequest.approvalsRequired} approvals${palette.reset}`;
  }
  if (mergeRequest.status === 'MERGEABLE') {
    return `${palette.add}mergeable${palette.reset}`;
  }
  if (mergeRequest.status !== '') {
    return `${palette.gray}${mergeRequest.status.toLowerCase()}${palette.reset}`;
  }
  return '';
}

/**
 * `#42 draft . ci run . 3 comments`. The status token binds to the reference
 * with a space - `#42 draft` names one thing - while CI, comments and the age
 * note are separate facts about the branch and take the separator.
 *
 * Deviation from the Claude bar: the comment count reads `3 comments` rather
 * than a speech-bubble emoji, which font-falls back to Segoe UI Emoji and draws
 * double-width into a single reserved cell.
 */
export function buildMergeRequestBlock(
  mergeRequest: MrFields | undefined,
  ageSeconds: number,
  palette: FooterPalette,
): string {
  if (mergeRequest === undefined || mergeRequest.iid === '') {
    return '';
  }
  const reference =
    mergeRequest.provider === 'github' ? `#${mergeRequest.iid}` : `!${mergeRequest.iid}`;
  const state = buildMergeRequestState(mergeRequest, palette);
  const head =
    `${palette.mr}${link(reference, mergeRequest.url)}${palette.reset}` +
    (state === '' ? '' : ` ${state}`);

  const ci = CI_STATE_BY_PIPELINE[mergeRequest.pipeline];
  const notes =
    isNonNegativeInt(mergeRequest.notes) && Number(mergeRequest.notes) > 0
      ? `${palette.gray}${mergeRequest.notes} comment${mergeRequest.notes === '1' ? '' : 's'}${palette.reset}`
      : '';

  return joinSegments(
    [
      head,
      ci === undefined
        ? ''
        : `${palette[ci.tone]}${link(ci.text, buildCiUrl(mergeRequest))}${palette.reset}`,
      notes,
      ageSeconds >= MERGE_REQUEST_STALE_NOTE_SECONDS
        ? `${palette.dim}${Math.trunc(ageSeconds / 60)}m ago${palette.reset}`
        : '',
    ],
    palette,
  );
}

// --- Row 10: dev-server ports ------------------------------------------------

/** Resolve the trusted MPX port projection for the active worktree. */
export function resolvePortsConfigPath(
  cwd: string,
  configured = process.env.MPX_WORKTREE_PORTS_FILE,
): string {
  const candidate = configured?.trim();
  if (candidate && !candidate.includes('\0') && path.isAbsolute(candidate)) {
    return path.normalize(candidate);
  }
  return path.join(cwd, '.worktree-ports.json');
}

const PORT_PROBE_TIMEOUT_MS = 400;

/** The protocol a listening dev server turned out to speak. */
export type PortScheme = 'http' | 'https';

export function devServerPortsFor(configPath: string): number[] {
  const services = readJsonFile(configPath)?.services;
  if (services === null || typeof services !== 'object' || Array.isArray(services)) {
    return [];
  }
  return [
    ...new Set(
      Object.values(services)
        .filter((port) => isNonNegativeInt(port) && Number(port) >= 1 && Number(port) <= 65535)
        .map(Number),
    ),
  ];
}

/**
 * TCP probe against localhost, resolving to the scheme the listener speaks, or
 * "" when nothing is there - refused and ignored alike, within the timeout.
 *
 * The host is `localhost` rather than 127.0.0.1 because a dev server may bind
 * ::1 only; Node's happy-eyeballs then tries both address families instead of
 * reporting an IPv6-only server as down. Once connected, a TLS handshake over
 * the same connection decides the scheme: a handshake the listener completes
 * means https, one it rejects or ignores means a plain http server received a
 * ClientHello it could not parse.
 */
export function probeDevServerPort(
  port: number,
  timeoutMs: number = PORT_PROBE_TIMEOUT_MS,
): Promise<PortScheme | ''> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    let connected = false;
    let settled = false;
    const finish = (scheme: PortScheme | ''): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(scheme);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(''));
    socket.once('error', () => finish(connected ? 'http' : ''));
    socket.once('connect', () => {
      connected = true;
      socket.setTimeout(0); // the TLS socket owns the deadline from here
      const secure = connectTls({ socket, servername: 'localhost', rejectUnauthorized: false });
      secure.setTimeout(timeoutMs);
      secure.once('secureConnect', () => finish('https'));
      secure.once('timeout', () => finish('http'));
      secure.once('error', () => finish('http'));
    });
  });
}

/** A port that is down is simply missing from the map, exactly as it is on disk. */
export async function probeDevServerPorts(
  ports: readonly number[],
): Promise<Map<number, PortScheme>> {
  const schemes = new Map<number, PortScheme>();
  const results = await Promise.all(ports.map((port) => probeDevServerPort(port)));
  ports.forEach((port, index) => {
    const scheme = results[index];
    if (scheme === 'http' || scheme === 'https') {
      schemes.set(port, scheme);
    }
  });
  return schemes;
}

/**
 * `:8100`-style segments: green while the server answers, dim while it does not,
 * and a browser link either way - clicking a dead one shows the browser's
 * connection error, which is a fine way to learn the server is down.
 *
 * The link carries the scheme the probe saw. It matters: an `http://` request to
 * a TLS listener is answered with zero bytes, which the browser reports as
 * ERR_EMPTY_RESPONSE rather than as the wrong scheme.
 *
 * A bare pencil closes a configured list; a project with no ports at all gets a
 * dim `pencil ports` hint instead, so the config is one click away either way.
 */
export function buildDevServerSegments(
  ports: readonly number[],
  portSchemes: ReadonlyMap<number, PortScheme>,
  configUrl: string,
  palette: FooterPalette,
): string[] {
  const segments = ports.map((port) => {
    const scheme = portSchemes.get(port);
    const color = scheme === undefined ? palette.dim : palette.add;
    return `${color}${link(`:${port}`, `${scheme ?? 'http'}://localhost:${port}`)}${palette.reset}`;
  });
  if (configUrl === '') {
    return segments;
  }
  const pencilLabel = ports.length === 0 ? `${PENCIL_ICON} ports` : PENCIL_ICON;
  return [...segments, `${palette.dim}${link(pencilLabel, configUrl)}${palette.reset}`];
}

/** Pure presentation over event-fed snapshots; no process or port I/O occurs here. */
export function buildManagedDevServerSegments(
  servers: readonly ManagedFooterSnapshot[],
  palette: FooterPalette,
): string[] {
  const colorByTone: Record<ManagedFooterTone, string> = {
    warning: palette.amber,
    success: palette.add,
    error: palette.warn,
    dim: palette.dim,
  };
  return servers.map((server) => {
    const segment = formatManagedDevServer(server);
    return `${colorByTone[segment.tone]}${segment.text}${palette.reset}`;
  });
}

// --- Row 11: subagent tally --------------------------------------------------

/**
 * The main bar's ledger of finished sub-agents, ported from
 * Package-local status-line and subagent-history helpers.
 *
 * The design win over the Claude side: Claude Code evicts a terminal task from
 * the status-line payload 30 s after it ends, so the Claude renderer has to
 * mirror every agent into a per-session TSV state file just to keep counting.
 * pi's vendored subagents fork emits `subagents:completed` / `subagents:failed`
 * on the shared extension event bus, this process stays alive for the whole
 * session, and the ledger is therefore an in-memory array. No TSV, no eviction
 * race, no state directory to garbage-collect.
 *
 * Split of duty, mirroring the Claude one exactly: the fork's above-editor
 * widget owns the *live* view (running agents, their model, thinking, context %
 * and elapsed time), this row owns the *history*. Nothing renders in both.
 */
export interface FinishedSubagent {
  id: string;
  /** The `subagent_type` it was spawned as. */
  type: string;
  /** Resolved model id; the main session's model when the agent declared none. */
  model: string;
  /** Declared thinking level, "" when the agent inherited the session's. */
  thinking: string;
  tokens: number;
  elapsedMs: number;
  /** The fork's terminal status: completed, error, aborted, stopped or steered. */
  status: string;
}

/**
 * A `subagents:completed` / `subagents:failed` payload as a ledger row, or
 * undefined when the payload is not one. `model` and `thinking` come from the
 * two fields this repo's vendored fork adds to `buildEventData`. Current fork
 * events report the actual resolved model; `sessionModel` is only a compatibility
 * fallback when an older or external event omits `model`.
 */
export function subagentFromLifecycleEvent(
  payload: unknown,
  sessionModel: string,
): FinishedSubagent | undefined {
  const id = jsonField(payload, 'id');
  if (typeof id !== 'string' || id === '') {
    return undefined;
  }
  const tokens = jsonField(jsonField(payload, 'tokens'), 'total');
  const model = jsonField(payload, 'model');
  const thinking = jsonField(payload, 'thinking');
  return {
    id,
    type: String(jsonField(payload, 'type') ?? ''),
    model: typeof model === 'string' && model !== '' ? model : sessionModel,
    thinking: typeof thinking === 'string' ? thinking : '',
    tokens: typeof tokens === 'number' && Number.isFinite(tokens) ? Math.trunc(tokens) : 0,
    elapsedMs: Math.trunc(Number(jsonField(payload, 'durationMs') ?? 0)) || 0,
    status: String(jsonField(payload, 'status') ?? ''),
  };
}

/** Green tick for the one status an agent reaches by finishing its work; red cross otherwise. */
function subagentStatusStyle(
  status: string,
  palette: FooterPalette,
): { glyph: string; color: string } {
  return status === COMPLETED
    ? { glyph: '\u2713', color: palette.add }
    : { glyph: '\u00d7', color: palette.contextRed };
}

/**
 * Row 11 - `Sigma N agents`, the models they ran on with their share of the
 * tokens, the agent types, then one spelled-out row per agent.
 *
 * Dim throughout: a ledger you consult, never a state to act on. The model
 * counts keep the accent because that is the one comparison worth making at a
 * glance.
 */
export const buildSubagentTallyRow: FooterRowBuilder = (snapshot) => {
  const { palette, subagents } = snapshot;
  if (subagents.length === 0) {
    return [];
  }

  const members = subagents.map((agent) => ({
    label: agent.model,
    tokens: agent.tokens,
    drifted: false,
  }));
  const models = groupMembers(members)
    // Model ids keep their real spelling - `gpt-5.6-sol`, not `Gpt-5.6-sol`.
    // The Claude bar capitalises because it groups by tier name, which is a
    // word; pi groups by the id the model is actually addressed as.
    .map(
      (group) =>
        `${palette.accent}${countLabel(group.count, group.label)} ${palette.dim}${formatTokens(group.tokens)}${palette.reset}`,
    )
    .join(' ');

  const typeGroups = groupMembers(
    subagents.map((agent) => ({ label: agent.type, tokens: agent.tokens, drifted: false })),
  ).sort((left, right) => right.count - left.count);
  const shownTypes = typeGroups.slice(0, AGENT_TYPE_ROWS);
  const types = shownTypes
    .map(
      (group) =>
        `${palette.gray}${group.count === 1 ? group.label : countLabel(group.count, group.label)}${palette.reset}`,
    )
    .concat(
      typeGroups.length > shownTypes.length
        ? [`${palette.dim}+${typeGroups.length - shownTypes.length}${palette.reset}`]
        : [],
    )
    .join(' ');

  const lines = [
    joinSegments(
      [
        `${palette.dim}\u03a3 ${subagents.length} agent${subagents.length === 1 ? '' : 's'}${palette.reset}`,
        models,
        types,
      ],
      palette,
    ),
  ];

  // Both columns size to the widest value actually on screen, and the gauges
  // still start at one column so their filled slots compare down the block.
  const rows = selectDetailRows(
    subagents.map((agent) => ({
      id: agent.id,
      type: agent.type,
      tier: agent.model,
      effort: agent.thinking,
      tokens: agent.tokens,
      elapsedMs: agent.elapsedMs,
      status: agent.status,
      drifted: false,
    })),
    AGENT_DETAIL_ROWS,
  );
  const nameWidth = Math.max(...rows.map((agent) => agent.type.length));
  const modelWidth = Math.max(...rows.map((agent) => agent.tier.length));
  for (const agent of rows) {
    const status = subagentStatusStyle(agent.status, palette);
    lines.push(
      `${INDENT_GUARD} ${status.color}${status.glyph}${palette.reset}` +
        ` ${palette.gray}${agent.type.padEnd(nameWidth)}${palette.reset}` +
        ` ${palette.accent}${agent.tier.padEnd(modelWidth)}${palette.reset}` +
        ` ${palette.dim}${thinkingGauge(agent.effort).padEnd(THINKING_GAUGE_SLOTS)}${palette.reset}` +
        ` ${palette.dim}${formatDuration(agent.elapsedMs).padStart(6)}${palette.reset}` +
        ` ${palette.gray}${formatTokens(agent.tokens).padStart(7)}${palette.reset}`,
    );
  }
  if (subagents.length > rows.length) {
    lines.push(
      `${INDENT_GUARD} ${palette.dim}+${subagents.length - rows.length} more${palette.reset}`,
    );
  }
  return lines;
};

// --- Row builders ------------------------------------------------------------

/** Everything a row may read. Assembled once per render; every field is a snapshot. */
export interface FooterSnapshot {
  palette: FooterPalette;
  nowSeconds: number;
  sessionName: string;
  sessionShortId: string;
  sessionFileUrl: string;
  sessionIdentity: FooterSessionIdentity;
  modelName: string;
  modelProvider: string;
  thinkingLevel: string;
  location: ProjectLocation;
  git: GitSnapshot | undefined;
  contextTokens: number | undefined;
  contextWindow: number;
  contextPercent: number | undefined;
  compactionTrigger: number;
  usage: SessionUsageTotals;
  compactions: readonly FooterCompactionEvent[];
  quota: CodexQuota | undefined;
  /** Row 9 - last successful provider read; undefined leaves the block absent. */
  mergeRequest: MrFields | undefined;
  /** Age of `mergeRequest`, in seconds. */
  mergeRequestAgeSeconds: number;
  /** Row 10 - ports declared for this worktree, in service declaration order. */
  devServerPorts: readonly number[];
  portsConfigPath: string;
  /** Row 10 - the scheme each answering port spoke; a silent port is absent. */
  devServerSchemes: ReadonlyMap<number, PortScheme>;
  /** Session-owned servers, updated only through the shared extension event bus. */
  managedDevServers: readonly ManagedFooterSnapshot[];
  /** Row 11 - sub-agents that have finished this session, in completion order. */
  subagents: readonly FinishedSubagent[];
  /** Available footer width, supplied by pi immediately before rendering. */
  width?: number;
}

export type FooterRowBuilder = (snapshot: FooterSnapshot) => string[];

/**
 * Adds a secondary hint at the far right without competing with essential left
 * status. Narrow terminals retain the status and drop the optional hint.
 */
export function appendRightAlignedFooterHint(
  line: string,
  hint: string,
  width: number | undefined,
): string {
  if (width === undefined || width <= 0) {
    return line;
  }
  const remainingColumns = width - visibleWidth(line) - visibleWidth(hint);
  return remainingColumns >= 2 ? `${line}${' '.repeat(remainingColumns)}${hint}` : line;
}

/** The high-frequency editor controls, ordered in the six rows they occupy. */
export const FOOTER_SHORTCUT_PAIRS: readonly (readonly [string, string])[] = [
  ['Alt+P   model picker', 'Shift+Tab  cycle effort'],
  ['Ctrl+C  clear input', 'Ctrl+Shift+Down  next prompt'],
  ['Ctrl+D  exit (empty)', 'Alt+Enter  queue follow-up'],
  ['Ctrl+T  thinking blocks', 'Ctrl+X  copy response'],
  ['Ctrl+G  external editor', 'Ctrl+A/E  line start/end'],
  ['Ctrl+O  tool output', 'Ctrl+Shift+Up  previous prompt'],
];

const FOOTER_SHORTCUT_COLUMN_GAP = 3;
const FOOTER_SHORTCUT_COLUMN_WIDTH =
  Math.max(...FOOTER_SHORTCUT_PAIRS.map(([left]) => left.length)) + FOOTER_SHORTCUT_COLUMN_GAP;
const FOOTER_SHORTCUT_BLOCK_WIDTH = Math.max(
  ...FOOTER_SHORTCUT_PAIRS.map(
    ([left, right]) => left.padEnd(FOOTER_SHORTCUT_COLUMN_WIDTH).length + right.length,
  ),
);

/** Formats a fixed-width, two-column shortcut reference in the footer's dimmest weight. */
export function buildFooterShortcutRows(palette: FooterPalette): string[] {
  return FOOTER_SHORTCUT_PAIRS.map(([left, right]) => {
    const row = `${left.padEnd(FOOTER_SHORTCUT_COLUMN_WIDTH)}${right}`;
    return `${palette.dim}${row.padEnd(FOOTER_SHORTCUT_BLOCK_WIDTH)}${palette.reset}`;
  });
}

/**
 * Pins the six-line shortcut reference to the right edge beside the ordinary
 * footer. Missing left-side rows become blank spacer rows so the reference
 * remains a stable two-column, six-row block.
 */
export function appendFooterShortcutRows(
  lines: readonly string[],
  palette: FooterPalette,
  width: number,
): string[] {
  const shortcutRows = buildFooterShortcutRows(palette);
  const combinedLines = [...lines];
  for (let index = 0; index < shortcutRows.length; index++) {
    const leftLine = combinedLines[index] ?? '';
    const combinedLine = appendRightAlignedFooterHint(leftLine, shortcutRows[index], width);
    // Do not create blank footer rows when a narrow terminal cannot fit a hint.
    if (leftLine !== '' || combinedLine !== '') {
      combinedLines[index] = combinedLine;
    }
  }
  return combinedLines;
}

/** Row 8 — whose session this is, and one click to its raw JSONL. */
export const buildSessionRow: FooterRowBuilder = (snapshot) => {
  const { palette } = snapshot;
  const line = joinSegments(
    [
      snapshot.sessionName === ''
        ? ''
        : `${palette.session}${snapshot.sessionName}${palette.reset}`,
      snapshot.sessionShortId === ''
        ? ''
        : `${palette.gray}${link(`#${snapshot.sessionShortId}`, snapshot.sessionFileUrl)}${palette.reset}`,
    ],
    palette,
  );
  return line === '' ? [] : [line];
};

/** Row 2 — native Pi or the MPX launch identity and mode. */
export const buildIdentityRow: FooterRowBuilder = (snapshot) => {
  const { palette, sessionIdentity } = snapshot;
  return [
    joinSegments(
      [
        `${palette.accent}${sessionIdentity.runtimeLabel}${palette.reset}`,
        sessionIdentity.identity === ''
          ? ''
          : `${palette.gray}${sessionIdentity.identity}${palette.reset}`,
        sessionIdentity.mode === '' ? '' : `${palette.gray}${sessionIdentity.mode}${palette.reset}`,
      ],
      palette,
    ),
  ];
};

/** Row 3 — model and the thinking gauge. */
export const buildModelRow: FooterRowBuilder = (snapshot) => {
  const { palette } = snapshot;
  const gauge = thinkingGauge(snapshot.thinkingLevel);
  const line = joinSegments(
    [
      snapshot.modelName === '' ? '' : `${palette.accent}${snapshot.modelName}${palette.reset}`,
      gauge === '' ? '' : `${palette.gray}${gauge}${palette.reset}`,
    ],
    palette,
  );
  return line === '' ? [] : [line];
};

/**
 * Where you are, what is listening, and what is open against this branch. In a
 * linked worktree the two path halves are separate click targets and the
 * worktree half takes the brightest foreground, because it, not the project,
 * answers "where am I".
 *
 * The dev-server ports and the MR/PR block ride here rather than on rows of
 * their own because all four fields answer "where is this work".
 */
export const buildLocationRow: FooterRowBuilder = (snapshot) => {
  const { palette, location } = snapshot;
  const project = link(location.projectName, location.projectUrl);
  const name =
    location.worktreeName === ''
      ? `${palette.text}${project}${palette.reset}`
      : `${palette.gray}${project}${palette.reset}${palette.gray}/${palette.reset}` +
        `${palette.text}${link(location.worktreeName, location.worktreeUrl)}${palette.reset}`;
  const branch = snapshot.git?.status.branch ?? '';
  const line = joinSegments(
    [
      location.projectName === '' ? '' : name,
      branch === ''
        ? ''
        : `${palette.gray}${BRANCH_ICON} ${link(branch, snapshot.git?.branchUrl ?? '')}${palette.reset}`,
      ...buildDevServerSegments(
        snapshot.devServerPorts,
        snapshot.devServerSchemes,
        location.projectName === '' ? '' : toFileUrl(snapshot.portsConfigPath),
        palette,
      ),
      ...buildManagedDevServerSegments(snapshot.managedDevServers, palette),
      buildMergeRequestBlock(snapshot.mergeRequest, snapshot.mergeRequestAgeSeconds, palette),
    ],
    palette,
  );
  return line === '' ? [] : [line];
};

/**
 * Context escalation as a fraction of the compaction trigger, not of the model
 * window: full bar means compaction is about to fire, which is the only
 * threshold on this line anyone acts on. The percentage beside it still reads
 * against the window, so the two answer different questions on purpose.
 */
const CONTEXT_YELLOW_FRACTION = 0.5;
const CONTEXT_ORANGE_FRACTION = 0.7;
const CONTEXT_RED_FRACTION = 0.9;

export function contextEscalationColor(
  tokens: number | undefined,
  trigger: number,
  palette: FooterPalette,
): string {
  if (tokens === undefined || trigger <= 0) {
    return palette.gray;
  }
  if (tokens >= trigger * CONTEXT_RED_FRACTION) {
    return palette.contextRed;
  }
  if (tokens >= trigger * CONTEXT_ORANGE_FRACTION) {
    return palette.contextOrange;
  }
  if (tokens >= trigger * CONTEXT_YELLOW_FRACTION) {
    return palette.contextYellow;
  }
  return palette.gray;
}

/**
 * Rows 2 + 3 on one line — context bar and percentage, then the session's token
 * and cost totals. Cost is dim: a running total you check occasionally, not a
 * state to act on.
 *
 * `contextTokens` is undefined for the window between a compaction and the next
 * LLM response, where pi reports `tokens: null`; the whole context segment drops
 * out rather than rendering a zero that would read as "context emptied".
 */
export const buildUsageRow: FooterRowBuilder = (snapshot) => {
  const { palette } = snapshot;
  const color = contextEscalationColor(snapshot.contextTokens, snapshot.compactionTrigger, palette);

  let contextText = '';
  if (snapshot.contextTokens !== undefined) {
    contextText = formatTokenCount(snapshot.contextTokens);
    if (snapshot.contextPercent !== undefined) {
      contextText += ` (${Math.min(100, Math.trunc(snapshot.contextPercent))}%)`;
    }
  }
  const context = contextText === '' ? '' : `${color}${contextText}${palette.reset}`;

  let bar = '';
  if (snapshot.compactionTrigger > 0 && snapshot.contextTokens !== undefined) {
    bar = renderProgressBar(
      Math.trunc((snapshot.contextTokens * 100) / snapshot.compactionTrigger),
      10,
      color,
      palette,
    );
  }

  const { usage } = snapshot;
  const tokens =
    usage.input === 0 && usage.output === 0
      ? ''
      : `${palette.dim}\u2191${formatTokenCount(usage.input)} \u2193${formatTokenCount(usage.output)}${palette.reset}`;
  const cost =
    usage.costUsd <= 0 ? '' : `${palette.dim}$${usage.costUsd.toFixed(3)}${palette.reset}`;

  const line = joinSegments(
    [[context, bar].filter((part) => part !== '').join(' '), tokens, cost],
    palette,
  );
  return line === '' ? [] : [line];
};

/** How a compaction reason reads, and whether it is worth a colour of its own. */
function compactionReasonLabel(reason: string): string {
  return reason === '' ? 'compact' : reason;
}

/**
 * Row 7 — one row per compaction on the active branch, oldest first, nested
 * under the context row that owns them. Only the last `COMPACTION_ROWS` are
 * spelled out: the recent ones are what tell you whether the session you came
 * back to is still the session you left.
 *
 * Deviation from the Claude Code renderer, which drew `227k → 11k`: pi's
 * `CompactionEntry` records `tokensBefore` only, so the post-compaction size is
 * not available and the row states the trigger point alone rather than inventing
 * the other half.
 */
export const buildCompactionRows: FooterRowBuilder = (snapshot) => {
  const { palette, compactions } = snapshot;
  if (compactions.length === 0) {
    return [];
  }
  const indent = `${INDENT_GUARD} `;
  const shown = compactions.slice(-COMPACTION_ROWS);
  const hidden = compactions.length - shown.length;
  const lines: string[] = [];

  if (hidden > 0) {
    lines.push(`${indent}${palette.dim}\u251c\u2500 ${hidden} earlier${palette.reset}`);
  }
  shown.forEach((event, index) => {
    const glyph = `${palette.dim}${index === shown.length - 1 ? '\u2514\u2500' : '\u251c\u2500'}${palette.reset}`;
    // `manual` is the one you were there for; everything else is a
    // compaction you did not choose, which is the only thing on the row
    // worth catching.
    const label = event.reason === 'manual' ? palette.gray : palette.amber;
    let line = `${indent}${glyph} ${label}${compactionReasonLabel(event.reason).padEnd(9)}${palette.reset}`;
    line += ` ${palette.gray}\u00b7${palette.reset} ${palette.gray}${formatTokensK(event.tokensBefore)}${palette.reset}`;
    const clock = formatClock(event.timestamp);
    if (clock !== '') {
      line += ` ${palette.dim}\u00b7${palette.reset} ${palette.dim}${clock}${palette.reset}`;
    }
    lines.push(line);
  });
  return lines;
};

/**
 * Row 4 — Codex subscription quota. Hidden entirely when there is no data or
 * the selected model is not using the `openai-codex` account whose limits these
 * windows describe.
 */
export const buildQuotaRow: FooterRowBuilder = (snapshot) => {
  const { palette, quota } = snapshot;
  if (quota === undefined || snapshot.modelProvider !== CODEX_PROVIDER) {
    return [];
  }
  const age = snapshot.nowSeconds - quota.observedAtEpochSeconds;
  const window = (label: string, data: CodexQuotaWindow | undefined): string => {
    if (data === undefined) {
      return '';
    }
    const percent = Math.max(0, Math.min(100, Math.round(data.usedPercent)));
    let segment = `${palette.gray}${label}${palette.reset} ${renderProgressBar(percent, 8, palette.accent, palette)} ${palette.gray}${percent}%${palette.reset}`;
    const countdown =
      data.resetAtEpochSeconds === undefined
        ? ''
        : timeUntil(String(data.resetAtEpochSeconds), snapshot.nowSeconds);
    if (countdown !== '') {
      segment += ` ${palette.dim}${countdown}${palette.reset}`;
    }
    return segment;
  };

  const line = joinSegments(
    [
      window(formatQuotaWindowLabel(quota.primary?.windowMinutes, '5h'), quota.primary),
      window(formatQuotaWindowLabel(quota.secondary?.windowMinutes, '7d'), quota.secondary),
      age > QUOTA_STALE_SECONDS ? `${palette.dim}${humanAge(age)}${palette.reset}` : '',
    ],
    palette,
  );
  return line === '' ? [] : [line];
};

/**
 * Display order — session, launch identity, model, location, running totals
 * and compaction history, quota, then the sub-agent ledger. Merge request and
 * dev-server details compose into the location row.
 */
export const FOOTER_ROW_BUILDERS: readonly FooterRowBuilder[] = [
  buildSessionRow,
  buildIdentityRow,
  buildModelRow,
  buildLocationRow,
  buildUsageRow,
  buildCompactionRows,
  buildQuotaRow,
  buildSubagentTallyRow,
];

export function renderFooterRows(
  snapshot: FooterSnapshot,
  builders: readonly FooterRowBuilder[] = FOOTER_ROW_BUILDERS,
): string[] {
  const lines: string[] = [];
  for (const builder of builders) {
    lines.push(...builder(snapshot));
  }
  return lines;
}

class AutocompleteAwareEditor extends CustomEditor {
  onAutocompleteVisibilityChange: ((visible: boolean) => void) | undefined;
  private autocompleteVisible: boolean | undefined;

  override handleInput(data: string): void {
    super.handleInput(data);
    this.syncAutocompleteVisibility();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    this.syncAutocompleteVisibility();
    return lines;
  }

  private syncAutocompleteVisibility(): void {
    const visible = this.isShowingAutocomplete();
    if (visible === this.autocompleteVisible) {
      return;
    }
    this.autocompleteVisible = visible;
    this.onAutocompleteVisibilityChange?.(visible);
  }
}

// --- Extension wiring --------------------------------------------------------

const GIT_REFRESH_INTERVAL_MS = 15_000;
const QUOTA_REFRESH_INTERVAL_MS = 60_000;
const QUOTA_FETCH_TIMEOUT_MS = 5_000;

function agentDirectory(cwd: string): string {
  return resolvePiCodingAgentDir(cwd);
}

function nowSeconds(): number {
  return Math.trunc(Date.now() / 1000);
}

export default function (pi: ExtensionAPI): void {
  let gitSnapshot: GitSnapshot | undefined;
  let quota: CodexQuota | undefined;
  let settings: CompactionSettingsSnapshot = { ...DEFAULT_COMPACTION_SETTINGS };
  let currentContext: ExtensionContext | undefined;
  let quotaLastFetchAttemptEpochSeconds = 0;
  let gitRefreshInFlight = false;
  let quotaRefreshInFlight = false;

  let mergeRequest: MrFields | undefined;
  let mergeRequestBranch = '';
  let mergeRequestAttemptedAt = 0;
  let mergeRequestRefreshInFlight = false;

  let portsConfigPath = '';
  let devServerPorts: readonly number[] = [];
  let devServerSchemes: ReadonlyMap<number, PortScheme> = new Map();
  let portProbeInFlight = false;

  /** Managed snapshots arrive over the event boundary; rendering never probes their processes. */
  const managedDevServers = new Map<string, ManagedFooterSnapshot>();

  /**
   * Finished sub-agents, oldest first. In-process for the life of the session:
   * pi's extension host outlives every agent it spawns, which is the whole
   * reason this needs none of the Claude side's TSV state file.
   */
  const finishedSubagents: FinishedSubagent[] = [];

  /**
   * The main session's model, which a sub-agent that declared none inherits.
   * Captured when it changes rather than read at render time, because a row
   * has to keep the model the agent actually ran on after a later `/model`.
   */
  let currentSessionModel = '';

  /**
   * pi persists the compaction entry but not what triggered it, so the reason
   * is remembered here for the entries this process saw. A session resumed
   * from disk renders its older compactions without one.
   */
  const compactionReasonByEntryId = new Map<string, string>();

  // Digest of the active branch, recomputed only when the leaf moves — the
  // footer re-renders far more often than the session grows.
  let digestLeafId: string | null | undefined;
  let digestUsage: SessionUsageTotals = { ...EMPTY_SESSION_USAGE };
  let digestCompactions: FooterCompactionEvent[] = [];

  let requestRender: () => void = () => {};

  const refreshGit = (ctx: ExtensionContext): void => {
    if (gitRefreshInFlight) {
      return;
    }
    gitRefreshInFlight = true;
    void readGitSnapshot(ctx.cwd)
      .then((snapshot) => {
        gitSnapshot = snapshot;
        // Both dependants key off what git just reported: the port list
        // off the project name a worktree resolves to, the MR/PR block
        // off the branch.
        portsConfigPath = resolvePortsConfigPath(ctx.cwd);
        devServerPorts = devServerPortsFor(portsConfigPath);
        refreshDevServerPorts();
        refreshMergeRequest(ctx);
        requestRender();
      })
      .catch(() => {
        gitSnapshot = undefined;
      })
      .finally(() => {
        gitRefreshInFlight = false;
      });
  };

  /**
   * One provider call per TTL, with a floor between attempts so a branch with
   * no open PR - which is a perfectly valid, cacheable answer - does not
   * re-ask on every tick. Switching branches drops the previous answer
   * immediately rather than showing another branch's PR until the refresh
   * lands.
   */
  const refreshMergeRequest = (ctx: ExtensionContext): void => {
    const branch = gitSnapshot?.status.branch ?? '';
    if (branch !== mergeRequestBranch) {
      mergeRequestBranch = branch;
      mergeRequest = undefined;
      mergeRequestAttemptedAt = 0;
    }
    if (branch === '' || mergeRequestRefreshInFlight) {
      return;
    }
    const now = nowSeconds();
    const age =
      mergeRequest === undefined ? Number.MAX_SAFE_INTEGER : now - Number(mergeRequest.timestamp);
    if (
      age < MERGE_REQUEST_TTL_SECONDS ||
      now - mergeRequestAttemptedAt < MERGE_REQUEST_ATTEMPT_FLOOR_SECONDS
    ) {
      return;
    }
    mergeRequestAttemptedAt = now;
    mergeRequestRefreshInFlight = true;
    void readMergeRequest(ctx.cwd, branch)
      .then((fields) => {
        if (fields !== undefined) {
          mergeRequest = fields;
          requestRender();
        }
      })
      .catch(() => {
        // A failed provider call leaves the previous answer on screen
        // with its age note; it never blanks the row.
      })
      .finally(() => {
        mergeRequestRefreshInFlight = false;
      });
  };

  /** Sockets, not a shell-out, but still off the render path and still cached. */
  const refreshDevServerPorts = (): void => {
    if (portProbeInFlight || devServerPorts.length === 0) {
      return;
    }
    portProbeInFlight = true;
    void probeDevServerPorts(devServerPorts)
      .then((schemes) => {
        devServerSchemes = schemes;
        requestRender();
      })
      .catch(() => {
        devServerSchemes = new Map();
      })
      .finally(() => {
        portProbeInFlight = false;
      });
  };

  /**
   * Refresh quota from the usage endpoint at most once a minute. Provider
   * headers remain the free fast path, but their observation timestamp must
   * not suppress this poll: a long tool turn can keep receiving headers whose
   * quota values lag until the response stream has fully settled.
   */
  const refreshQuota = (ctx: ExtensionContext): void => {
    if (quotaRefreshInFlight) {
      return;
    }
    if (ctx.model?.provider !== CODEX_PROVIDER) {
      return;
    }
    const currentEpochSeconds = nowSeconds();
    if (
      currentEpochSeconds - quotaLastFetchAttemptEpochSeconds <
      QUOTA_REFRESH_INTERVAL_MS / 1000
    ) {
      return;
    }
    quotaLastFetchAttemptEpochSeconds = currentEpochSeconds;
    quotaRefreshInFlight = true;
    void (async () => {
      try {
        const token = await ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER);
        if (token === undefined || token === '') {
          return;
        }
        const accountId = accountIdFromBearerToken(token);
        if (accountId === undefined) {
          return;
        }
        const response = await fetch(CODEX_USAGE_ENDPOINT, {
          headers: { Authorization: `Bearer ${token}`, 'chatgpt-account-id': accountId },
          signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          return;
        }
        const parsed = parseCodexUsageResponse(await response.json(), nowSeconds());
        if (parsed === undefined) {
          return;
        }
        quota = parsed;
        requestRender();
      } catch {
        // The next one-minute tick retries transient auth or network failures.
      } finally {
        quotaRefreshInFlight = false;
      }
    })();
  };

  // Free quota: pi already made the request, the numbers ride on its response.
  pi.on('after_provider_response', (event) => {
    const parsed = parseCodexQuotaHeaders(event.headers, nowSeconds());
    if (parsed !== undefined) {
      quota = parsed;
      requestRender();
    }
  });

  /**
   * The sub-agent ledger, fed by the vendored fork's lifecycle events on the
   * shared extension bus (`dist/core/extensions/loader.js` hands every
   * extension the same `EventBus`). Both terminal events carry the same
   * payload shape; `status` is what separates a finished agent from a broken
   * one on the row.
   */
  const recordFinishedSubagent = (payload: unknown): void => {
    const agent = subagentFromLifecycleEvent(payload, currentSessionModel);
    if (agent === undefined || finishedSubagents.some((known) => known.id === agent.id)) {
      return;
    }
    finishedSubagents.push(agent);
    requestRender();
  };
  pi.events.on('subagents:completed', recordFinishedSubagent);
  pi.events.on('subagents:failed', recordFinishedSubagent);
  const unsubscribeManagedDevServers = subscribeManagedDevServerEvents(pi.events, (snapshot) => {
    managedDevServers.set(snapshot.id, snapshot);
    requestRender();
  });
  pi.on('session_shutdown', () => {
    unsubscribeManagedDevServers();
    managedDevServers.clear();
  });

  pi.on('session_compact', (event) => {
    compactionReasonByEntryId.set(event.compactionEntry.id, event.reason);
    digestLeafId = undefined;
  });

  // End of turn is when the working tree most likely changed, and it is the
  // one moment a shell-out costs nothing anybody is waiting on.
  pi.on('agent_settled', (_event, ctx) => {
    refreshGit(ctx);
    refreshQuota(ctx);
    refreshMergeRequest(ctx);
    refreshDevServerPorts();
  });

  // A model or thinking change moves two fields on the bar and touches no I/O.
  pi.on('model_select', (_event, ctx) => {
    currentSessionModel = ctx.model?.id ?? currentSessionModel;
    requestRender();
  });
  pi.on('thinking_level_select', () => requestRender());
  pi.on('session_info_changed', () => requestRender());

  // pi has no extension-load event, so `session_start` is the earliest point a
  // ctx exists. It fires again on reload/resume/fork; the footer is installed
  // once and its component keeps reading through the live ctx.
  let footerInstalled = false;

  pi.on('session_start', (_event, ctx) => {
    currentContext = ctx;
    settings = readCompactionSettings(agentDirectory(ctx.cwd), ctx.cwd);
    currentSessionModel = ctx.model?.id ?? '';
    digestLeafId = undefined;
    refreshGit(ctx);
    refreshQuota(ctx);
    if (footerInstalled || ctx.mode !== 'tui') {
      return;
    }
    footerInstalled = true;

    let autocompleteVisible = false;
    ctx.ui.setWidget(
      'footer-autocomplete-separator',
      (_tui, theme) => ({
        render(width: number): string[] {
          return autocompleteVisible ? [theme.fg('borderMuted', '─'.repeat(width))] : [];
        },
        invalidate() {},
      }),
      { placement: 'belowEditor' },
    );
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new AutocompleteAwareEditor(tui, theme, keybindings);
      editor.onAutocompleteVisibilityChange = (visible) => {
        autocompleteVisible = visible;
        tui.requestRender();
      };
      return editor;
    });

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const refreshCurrentGit = (): void => {
        if (currentContext !== undefined) {
          refreshGit(currentContext);
        }
      };
      const refreshCurrentQuota = (): void => {
        if (currentContext !== undefined) {
          refreshQuota(currentContext);
        }
      };
      const unsubscribeBranch = footerData.onBranchChange(refreshCurrentGit);
      const gitTimer = setInterval(refreshCurrentGit, GIT_REFRESH_INTERVAL_MS);
      const quotaTimer = setInterval(refreshCurrentQuota, QUOTA_REFRESH_INTERVAL_MS);
      // Footer timers must never be the reason the process stays alive.
      gitTimer.unref?.();
      quotaTimer.unref?.();

      const palette = resolveFooterPalette(theme as unknown as FooterTheme);

      return {
        dispose() {
          clearInterval(gitTimer);
          clearInterval(quotaTimer);
          unsubscribeBranch();
          requestRender = () => {};
        },
        invalidate() {},
        render(width: number): string[] {
          const activeContext = currentContext ?? ctx;
          const session = activeContext.sessionManager;
          const leafId = session.getLeafId();
          if (leafId !== digestLeafId) {
            const branch = session.getBranch();
            digestUsage = collectSessionUsage(branch);
            digestCompactions = compactionEventsFromEntries(branch, compactionReasonByEntryId);
            digestLeafId = leafId;
          }

          const contextUsage = activeContext.getContextUsage();
          const contextWindow =
            contextUsage?.contextWindow ?? activeContext.model?.contextWindow ?? 0;
          const sessionFile = session.getSessionFile();

          const snapshot: FooterSnapshot = {
            palette,
            nowSeconds: nowSeconds(),
            sessionName: session.getSessionName() ?? '',
            sessionShortId: session.getSessionId().slice(0, 8),
            sessionFileUrl: sessionFile === undefined ? '' : toFileUrl(sessionFile),
            sessionIdentity: resolveFooterSessionIdentity(),
            modelName: activeContext.model?.id ?? '',
            modelProvider: activeContext.model?.provider ?? '',
            thinkingLevel: activeContext.thinkingLevel ?? settings.defaultThinkingLevel,
            location: resolveProjectLocation(activeContext.cwd, gitSnapshot?.worktree),
            git: gitSnapshot,
            contextTokens: contextUsage?.tokens ?? undefined,
            contextWindow,
            contextPercent: contextUsage?.percent ?? undefined,
            compactionTrigger: compactionTriggerTokens(contextWindow, settings),
            usage: digestUsage,
            compactions: digestCompactions,
            quota,
            mergeRequest,
            mergeRequestAgeSeconds:
              mergeRequest === undefined ? 0 : nowSeconds() - Number(mergeRequest.timestamp),
            devServerPorts,
            portsConfigPath,
            devServerSchemes,
            managedDevServers: [...managedDevServers.values()],
            subagents: finishedSubagents,
            width,
          };

          return appendFooterShortcutRows(renderFooterRows(snapshot), palette, width).map((line) =>
            truncateToWidth(line, width),
          );
        },
      };
    });
  });
}
