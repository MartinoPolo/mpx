import type { Theme } from '@earendil-works/pi-coding-agent';
import { hyperlink, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export interface FooterLocation {
  project: string;
  worktree?: string;
  branch?: string;
  projectUrl?: string;
  worktreeUrl?: string;
  branchUrl?: string;
}

export interface FooterCompaction {
  id: string;
  timestamp: string;
  tokensBefore?: number;
  reason?: string;
  url?: string;
}

export interface FooterQuotaWindow {
  label: string;
  usedPercent: number;
  resetAt?: number;
}

export interface FooterAgent {
  id: string;
  type: string;
  status: string;
  model?: string;
  effort?: string;
  elapsedMs?: number;
  url?: string;
}

export interface FooterSnapshot {
  sessionName?: string;
  sessionId: string;
  sessionUrl?: string;
  account?: 'personal' | 'work';
  model?: string;
  effort?: string;
  location: FooterLocation;
  contextPercent?: number | null;
  contextTokens?: number | null;
  compactionTrigger?: number;
  cost?: number;
  compactions: readonly FooterCompaction[];
  quota?: readonly FooterQuotaWindow[];
  quotaObservedAt?: number;
  agents: readonly FooterAgent[];
  now?: number;
}

type FooterTheme = Pick<Theme, 'fg' | 'bold'>;

const EFFORT: Readonly<Record<string, number>> = {
  off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6,
};
const EFFORT_COLOR: Readonly<Record<string, number>> = {
  off: 255, minimal: 245, low: 114, medium: 75, high: 179, xhigh: 208, max: 203,
};
const MAX_HISTORY = 5;
const MAX_AGENTS = 5;
const ACCOUNT_COLOR = {
  personal: '\x1b[38;2;71;127;204m',
  work: '\x1b[38;2;194;122;53m',
} as const;
const RESET = '\x1b[0m';

function safeText(value: string | undefined, fallback = 'unknown'): string {
  if (value === undefined) return fallback;
  const safe = stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  return safe || fallback;
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!['file:', 'http:', 'https:'].includes(parsed.protocol)) return undefined;
    if (parsed.username || parsed.password) return undefined;
    // Validate with URL, but retain the collector's complete target verbatim.
    return value;
  } catch {
    return undefined;
  }
}

function linked(text: string, url: string | undefined): string {
  const target = safeUrl(url);
  return target ? hyperlink(text, target) : text;
}

function bounded(line: string, width: number): string {
  return width <= 0 ? '' : truncateToWidth(line, width, '…');
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function shortModel(value: string | undefined): string {
  const model = safeText(value, 'model unavailable');
  const slash = model.indexOf('/');
  return slash < 0 ? model : model.slice(slash + 1) || 'model unavailable';
}

export function thinkingGauge(level: string): string {
  const clean = safeText(level, '<unknown>').toLowerCase();
  const filled = EFFORT[clean];
  if (filled === undefined) return '<unknown>';
  return `\x1b[38;5;${EFFORT_COLOR[clean]}m${'◆'.repeat(filled)}${'◇'.repeat(6 - filled)}${RESET}`;
}

function footerSeparator(theme: FooterTheme): string {
  return theme.fg('dim', ' · ');
}

function sessionLine(snapshot: FooterSnapshot, width: number, theme: FooterTheme): string {
  const id = safeText(snapshot.sessionId, '').slice(0, 8) || 'unknown';
  const account = snapshot.account;
  const accountLabel = account === 'personal' ? 'Personal' : account === 'work' ? 'Work' : undefined;
  const suffix = ` · #${id}${accountLabel ? ` · ${accountLabel}` : ''}`;
  const nameWidth = Math.max(1, width - visibleWidth(suffix));
  const name = bounded(safeText(snapshot.sessionName, 'New session'), nameWidth);
  const styledName = linked(theme.fg('warning', theme.bold(name)), snapshot.sessionUrl);
  const styledId = linked(theme.fg('dim', `#${id}`), snapshot.sessionUrl);
  const styledAccount = accountLabel && account
    ? `${ACCOUNT_COLOR[account]}${accountLabel}${RESET}`
    : undefined;
  const separator = footerSeparator(theme);
  return bounded(`${styledName}${separator}${styledId}${styledAccount ? `${separator}${styledAccount}` : ''}`, width);
}

function modelLine(snapshot: FooterSnapshot, theme: FooterTheme): string {
  const model = theme.fg('accent', shortModel(snapshot.model));
  const level = safeText(snapshot.effort, 'unknown').toLowerCase();
  return `${model}${footerSeparator(theme)}${thinkingGauge(level)}`;
}

function locationLine(location: FooterLocation, width: number, theme: FooterTheme): string {
  const separator = footerSeparator(theme);
  const fields = [
    { value: location.project, url: location.projectUrl },
    ...(location.worktree === undefined ? [] : [{ value: location.worktree, url: location.worktreeUrl }]),
    { value: location.branch, url: location.branchUrl },
  ];
  const available = Math.max(fields.length, width - (fields.length - 1) * visibleWidth(separator));
  const base = Math.max(1, Math.floor(available / fields.length));
  return fields.map(({ value, url }, index) => {
    const allocation = index === fields.length - 1 ? Math.max(1, available - base * index) : base;
    const label = bounded(safeText(value), allocation);
    const colored = index === 0 ? `\x1b[38;2;255;255;255m${label}${RESET}` : theme.fg('muted', label);
    return linked(colored, url);
  }).join(separator);
}

function progressBar(usedPercent: number, width: number, color: (text: string) => string, theme: FooterTheme): string {
  const cells = Math.round(Math.max(0, Math.min(100, usedPercent)) * width / 100);
  return color('█'.repeat(cells)) + theme.fg('borderMuted', '░'.repeat(width - cells));
}

function formatTokenCount(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.trunc(tokens));
}

function contextLine(snapshot: FooterSnapshot, theme: FooterTheme): string {
  const tokens = snapshot.contextTokens;
  const trigger = snapshot.compactionTrigger;
  let contextPart = theme.fg('muted', 'usage unavailable');
  if (finite(tokens) && tokens >= 0) {
    const fill = finite(trigger) && trigger > 0 ? tokens * 100 / trigger : undefined;
    const color = (text: string) => fill !== undefined && fill >= 90 ? theme.fg('error', text)
      : fill !== undefined && fill >= 70 ? `\x1b[38;5;208m${text}${RESET}`
      : theme.fg(fill !== undefined && fill >= 50 ? 'warning' : 'muted', text);
    const count = formatTokenCount(tokens);
    const percentage = finite(snapshot.contextPercent) ? ` (${percent(Math.trunc(snapshot.contextPercent))})` : '';
    contextPart = color(`${count}${percentage}`);
    if (fill !== undefined) contextPart += ` ${progressBar(Math.trunc(fill), 10, color, theme)}`;
  }
  const cost = finite(snapshot.cost) && snapshot.cost >= 0
    ? `$${snapshot.cost.toFixed(3)}`
    : 'cost unavailable';
  return `${contextPart}${footerSeparator(theme)}${theme.fg('muted', cost)}`;
}

function duration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
  if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  return `${minutes}m${totalSeconds % 60 ? ` ${totalSeconds % 60}s` : ''}`;
}

function quotaLine(snapshot: FooterSnapshot, theme: FooterTheme): string {
  if (!snapshot.quota?.length) return theme.fg('muted', 'unavailable');
  const now = finite(snapshot.now) ? snapshot.now : Date.now();
  const stale = finite(snapshot.quotaObservedAt) && now - snapshot.quotaObservedAt > 15 * 60_000;
  const windows = snapshot.quota.map(window => {
    const label = safeText(window.label);
    if (finite(window.resetAt) && window.resetAt <= now) return theme.fg('muted', `${label} awaiting update`);
    const usage = finite(window.usedPercent)
      ? `${progressBar(Math.round(window.usedPercent), 8, text => theme.fg('accent', text), theme)} ${theme.fg('muted', percent(window.usedPercent))}`
      : theme.fg('muted', 'unavailable');
    const reset = finite(window.resetAt) ? duration(window.resetAt - now) : 'reset unavailable';
    return `${theme.fg('muted', label)} ${usage} ${theme.fg('dim', reset)}${stale ? `${footerSeparator(theme)}${theme.fg('dim', 'stale')}` : ''}`;
  });
  return windows.join(footerSeparator(theme));
}

function compactionTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'time unavailable';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function compactionLines(compactions: readonly FooterCompaction[], theme: FooterTheme): string[] {
  if (!compactions.length) return [];
  const visible = compactions.slice(-MAX_HISTORY);
  const entries: Array<{ reason: string; time?: string; url?: string; tokensBefore?: number }> = [];
  if (compactions.length > visible.length) entries.push({ reason: `… ${compactions.length - visible.length} earlier compactions` });
  for (const item of visible) entries.push({ reason: safeText(item.reason, 'compacted'), time: compactionTime(item.timestamp), url: item.url, tokensBefore: item.tokensBefore });
  return entries.map((entry, index) => {
    const connector = theme.fg('dim', `  ${index === entries.length - 1 ? '└─' : '├─'} `);
    const reason = linked(theme.fg(entry.reason === 'manual' ? 'muted' : 'warning', entry.reason), entry.url);
    const tokens = finite(entry.tokensBefore) && entry.tokensBefore >= 0 ? `${footerSeparator(theme)}${theme.fg('muted', formatTokenCount(entry.tokensBefore))}` : '';
    const time = entry.time ? `${footerSeparator(theme)}${theme.fg('dim', entry.time)}` : '';
    return `${connector}${reason}${tokens}${time}`;
  });
}

function agentGlyph(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'done' || normalized === 'success') return '✓';
  if (normalized === 'stopped' || normalized === 'aborted' || normalized === 'cancelled') return '■';
  return '×';
}

function agentLines(agents: readonly FooterAgent[], theme: FooterTheme): string[] {
  if (!agents.length) return [];
  const visible = agents.slice(-MAX_AGENTS);
  const rows = [theme.bold('Finished agents')];
  if (agents.length > visible.length) rows.push(theme.fg('dim', `… ${agents.length - visible.length} earlier agents`));
  for (const agent of visible) {
    const glyph = agentGlyph(safeText(agent.status));
    const color = glyph === '✓' ? 'success' : glyph === '■' ? 'warning' : 'error';
    const model = shortModel(agent.model);
    const effort = safeText(agent.effort, '<unknown>');
    const elapsed = finite(agent.elapsedMs) && agent.elapsedMs >= 0 ? duration(agent.elapsedMs) : 'unknown';
    const text = [`${theme.fg(color, glyph)} ${safeText(agent.type)}`, theme.fg('accent', model), thinkingGauge(effort), elapsed].join(footerSeparator(theme));
    rows.push(linked(text, agent.url));
  }
  return rows;
}

export function renderPiFooter(snapshot: FooterSnapshot, width: number, theme: FooterTheme): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const columns = Math.max(1, Math.floor(width));
  const makeCore = (coreWidth: number): string[] => [
    sessionLine(snapshot, coreWidth, theme),
    modelLine(snapshot, theme),
    locationLine(snapshot.location, coreWidth, theme),
    contextLine(snapshot, theme),
    ...compactionLines(snapshot.compactions, theme),
    quotaLine(snapshot, theme),
  ];
  const agents = agentLines(snapshot.agents, theme);
  if (!agents.length) return makeCore(columns).map(line => bounded(line, columns));

  const gap = theme.fg('dim', ' │ ');
  const leftWidth = Math.floor(columns * 0.58);
  const rightWidth = columns - leftWidth - visibleWidth(gap);
  if (leftWidth < 60 || rightWidth < 65) {
    return [...makeCore(columns), ...agents].map(line => bounded(line, columns));
  }

  const core = makeCore(leftWidth);
  const count = Math.max(core.length, agents.length);
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const left = bounded(core[index] ?? '', leftWidth);
    const right = bounded(agents[index] ?? '', rightWidth);
    const padding = ' '.repeat(Math.max(0, leftWidth - visibleWidth(left)));
    rows.push(bounded(`${left}${padding}${gap}${right}`, columns));
  }
  return rows;
}
