import type { Theme } from '@earendil-works/pi-coding-agent';
import { hyperlink, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export type FooterView = 'compact' | 'summary' | 'details';

export interface FooterLocation {
  project: string;
  worktree?: string;
  branch?: string;
  projectUrl?: string;
  worktreeUrl?: string;
  branchUrl?: string;
  editorUrl?: string;
}

export interface FooterReview {
  provider: 'github' | 'gitlab';
  number: number;
  url: string;
  title?: string;
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
  tokens?: number;
  cost?: number;
}

export interface FooterSnapshot {
  sessionName?: string;
  sessionId: string;
  sessionUrl?: string;
  account?: 'personal' | 'work';
  model?: string;
  effort?: string;
  location: FooterLocation;
  review?: FooterReview;
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
const VSCODE_ICON = '󰨞';
const MAX_HISTORY = 5;
const MAX_AGENTS = 5;
const MAX_AGENT_GROUPS = 5;
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
    if (!['file:', 'http:', 'https:', 'vscode:'].includes(parsed.protocol)) return undefined;
    if (parsed.protocol === 'vscode:' && parsed.hostname !== 'file') return undefined;
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

function modelIdentifier(value: string | undefined): string {
  const original = safeText(value, 'model unavailable');
  const slash = original.indexOf('/');
  return slash < 0 ? original : original.slice(slash + 1) || 'model unavailable';
}

function shortModel(value: string | undefined): string {
  const model = modelIdentifier(value);
  const alias = model.match(/^gpt-\d+(?:\.\d+)?-(astra|luna|sol|terra)$/i)?.[1];
  return alias ? `${alias[0]!.toUpperCase()}${alias.slice(1).toLowerCase()}` : model;
}

export function colorAgentModel(value: string | undefined, label: string, theme: Pick<Theme, 'fg'>): string {
  const tier = modelIdentifier(value).match(/(?:^|-)(astra|luna|sol|terra)$/i)?.[1]?.toLowerCase();
  const color = tier === 'astra' ? 48 : tier === 'sol' ? 39 : tier === 'luna' ? 226 : tier === 'terra' ? 208 : undefined;
  return color === undefined ? theme.fg('accent', label) : `\x1b[38;5;${color}m${label}${RESET}`;
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

function modelLine(snapshot: FooterSnapshot, width: number, theme: FooterTheme): string {
  const separator = footerSeparator(theme);
  const gauge = thinkingGauge(safeText(snapshot.effort, 'unknown').toLowerCase());
  const review = snapshot.review;
  const reference = review ? `${review.provider === 'github' ? 'PR #' : 'MR !'}${review.number}` : '';
  const reservedWidth = visibleWidth(gauge) + visibleWidth(separator)
    + (review ? visibleWidth(separator) + visibleWidth(reference) : 0);
  const model = colorAgentModel(snapshot.model, bounded(shortModel(snapshot.model), Math.max(1, width - reservedWidth)), theme);
  const modelAndEffort = `${model}${separator}${gauge}`;
  if (!review) return modelAndEffort;
  const reviewLink = linked(theme.fg('accent', reference), review.url);
  const metadata = review.title === undefined ? '' : `${separator}${theme.fg('muted', safeText(review.title, ''))}`;
  return `${modelAndEffort}${separator}${reviewLink}${metadata}`;
}

function locationLine(location: FooterLocation, width: number, theme: FooterTheme): string {
  const separator = footerSeparator(theme);
  const editor = location.editorUrl === undefined ? '' : ` ${linked(theme.fg('muted', VSCODE_ICON), location.editorUrl)}`;
  const fields = [
    { value: location.project, url: location.projectUrl },
    ...(location.worktree === undefined ? [] : [{ value: location.worktree, url: location.worktreeUrl, maximum: 20 }]),
    { value: location.branch, url: location.branchUrl, maximum: 20 },
  ];
  const available = Math.max(fields.length, width - visibleWidth(editor) - (fields.length - 1) * visibleWidth(separator));
  const base = Math.max(1, Math.floor(available / fields.length));
  return fields.map(({ value, url, maximum }, index) => {
    const allocation = index === fields.length - 1 ? Math.max(1, available - base * index) : base;
    const label = bounded(safeText(value), Math.min(allocation, maximum ?? allocation));
    const colored = index === 0 ? `\x1b[38;2;255;255;255m${label}${RESET}` : theme.fg('muted', label);
    return `${linked(colored, url)}${index === 0 ? editor : ''}`;
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

function contextLine(snapshot: FooterSnapshot, theme: FooterTheme, showProgress = true, showCost = true): string {
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
    if (showProgress && fill !== undefined) contextPart += ` ${progressBar(Math.trunc(fill), 10, color, theme)}`;
  }
  const cost = showCost && finite(snapshot.cost) && snapshot.cost >= 0
    ? `${footerSeparator(theme)}${theme.fg('muted', `$${snapshot.cost.toFixed(3)}`)}`
    : '';
  return `${contextPart}${cost}`;
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

function quotaLine(snapshot: FooterSnapshot, theme: FooterTheme, showProgress = true): string {
  if (!snapshot.quota?.length) return theme.fg('muted', 'unavailable');
  const now = finite(snapshot.now) ? snapshot.now : Date.now();
  const stale = finite(snapshot.quotaObservedAt) && now - snapshot.quotaObservedAt > 15 * 60_000;
  const windows = snapshot.quota.map(window => {
    const label = safeText(window.label);
    if (finite(window.resetAt) && window.resetAt <= now) return theme.fg('muted', `${label} awaiting update`);
    const usage = finite(window.usedPercent)
      ? `${showProgress ? `${progressBar(Math.round(window.usedPercent), 8, text => theme.fg('accent', text), theme)} ` : ''}${theme.fg('muted', percent(window.usedPercent))}`
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
  if (normalized === 'stopped' || normalized === 'aborted' || normalized === 'cancelled' || normalized === 'steered') return '■';
  return '×';
}

function finishedAgents(agents: readonly FooterAgent[]): FooterAgent[] {
  return agents.filter(agent => ['completed', 'done', 'success', 'stopped', 'aborted', 'cancelled', 'failed', 'error', 'steered'].includes(agent.status.toLowerCase()));
}

function compareAgents(left: FooterAgent, right: FooterAgent): number {
  const leftPriced = finite(left.cost) && left.cost >= 0;
  const rightPriced = finite(right.cost) && right.cost >= 0;
  if (leftPriced !== rightPriced) return leftPriced ? -1 : 1;
  const leftCost = leftPriced ? left.cost! : -1;
  const rightCost = rightPriced ? right.cost! : -1;
  if (leftPriced && rightPriced && leftCost !== rightCost) return rightCost - leftCost;
  const leftTokens = finite(left.tokens) && left.tokens >= 0 ? left.tokens : -1;
  const rightTokens = finite(right.tokens) && right.tokens >= 0 ? right.tokens : -1;
  const leftElapsed = finite(left.elapsedMs) && left.elapsedMs >= 0 ? left.elapsedMs : -1;
  const rightElapsed = finite(right.elapsedMs) && right.elapsedMs >= 0 ? right.elapsedMs : -1;
  return rightTokens - leftTokens || rightElapsed - leftElapsed || left.id.localeCompare(right.id);
}

function agentLines(agents: readonly FooterAgent[], theme: FooterTheme): string[] {
  const finished = finishedAgents(agents).sort(compareAgents);
  if (!finished.length) return [];
  const visible = finished.slice(0, MAX_AGENTS);
  const rows = [theme.bold(`Finished agents (${finished.length})`)];
  if (finished.length > visible.length) rows.push(theme.fg('dim', `… ${finished.length - visible.length} more agents`));
  for (const agent of visible) {
    const glyph = agentGlyph(safeText(agent.status));
    const color = glyph === '✓' ? 'success' : glyph === '■' ? 'warning' : 'error';
    const model = shortModel(agent.model);
    const effort = safeText(agent.effort, '<unknown>');
    const elapsed = finite(agent.elapsedMs) && agent.elapsedMs >= 0 ? duration(agent.elapsedMs) : 'unknown';
    const metrics = [
      finite(agent.tokens) && agent.tokens >= 0 ? `${formatTokenCount(agent.tokens)} tokens` : undefined,
      finite(agent.cost) && agent.cost >= 0 ? `$${agent.cost.toFixed(3)}` : undefined,
    ].filter((value): value is string => value !== undefined);
    const text = [`${theme.fg(color, glyph)} ${colorAgentModel(agent.model, safeText(agent.type), theme)}`, colorAgentModel(agent.model, model, theme), thinkingGauge(effort), elapsed, ...metrics].join(footerSeparator(theme));
    rows.push(linked(text, agent.url));
  }
  return rows;
}

function agentSummaryLines(agents: readonly FooterAgent[], expanded: boolean, theme: FooterTheme): string[] {
  const finished = finishedAgents(agents);
  if (!finished.length) return [];
  const groups = new Map<string, { identifier: string; model: string; effort: string; count: number; tokens: number; tokenCount: number; cost: number; costCount: number }>();
  for (const agent of finished) {
    const identifier = modelIdentifier(agent.model);
    const model = shortModel(agent.model);
    const effort = safeText(agent.effort, '<unknown>').toLowerCase();
    const key = `${identifier}\u0000${effort}`;
    const group = groups.get(key) ?? { identifier, model, effort, count: 0, tokens: 0, tokenCount: 0, cost: 0, costCount: 0 };
    group.count++;
    if (finite(agent.tokens) && agent.tokens >= 0) { group.tokens += agent.tokens; group.tokenCount++; }
    if (finite(agent.cost) && agent.cost >= 0) { group.cost += agent.cost; group.costCount++; }
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((left, right) => {
    const leftPriced = left.costCount === left.count;
    const rightPriced = right.costCount === right.count;
    if (leftPriced !== rightPriced) return leftPriced ? -1 : 1;
    if (leftPriced && rightPriced && left.cost !== right.cost) return right.cost - left.cost;
    return right.tokens - left.tokens || left.model.localeCompare(right.model);
  });
  const visible = ordered.slice(0, MAX_AGENT_GROUPS);
  const rows = [`${expanded ? '▾' : '▸'} History (${finished.length})`];
  for (const group of visible) {
    const metrics = [`×${group.count}`];
    if (group.tokenCount === group.count) metrics.push(`${formatTokenCount(group.tokens)} tokens`);
    else if (group.tokenCount) metrics.push(`${formatTokenCount(group.tokens)} known tokens`);
    if (group.costCount === group.count) metrics.push(`$${group.cost.toFixed(3)}`);
    const label = ordered.some(other => other.model === group.model && other.identifier !== group.identifier) ? group.identifier : group.model;
    rows.push(`  ${colorAgentModel(group.identifier, label, theme)}${footerSeparator(theme)}${thinkingGauge(group.effort)}${footerSeparator(theme)}${metrics.join(footerSeparator(theme))}`);
  }
  if (ordered.length > visible.length) rows.push(theme.fg('dim', `  … ${ordered.length - visible.length} more groups`));
  return rows;
}

export function renderPiFooter(snapshot: FooterSnapshot, width: number, theme: FooterTheme, view: FooterView = 'summary'): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const columns = Math.max(1, Math.floor(width));
  if (view === 'compact') {
    const id = safeText(snapshot.sessionId, '').slice(0, 8) || 'unknown';
    const line = [
      theme.fg('dim', '▸'),
      linked(theme.fg('dim', `#${id}`), snapshot.sessionUrl),
      colorAgentModel(snapshot.model, shortModel(snapshot.model), theme),
      thinkingGauge(safeText(snapshot.effort, 'unknown').toLowerCase()),
      contextLine(snapshot, theme, false, false),
      quotaLine(snapshot, theme, false),
    ].join(footerSeparator(theme));
    return [bounded(line, columns)];
  }
  const core = [
    `${theme.fg('dim', '▾')} ${sessionLine(snapshot, Math.max(1, columns - 2), theme)}`,
    modelLine(snapshot, columns, theme),
    locationLine(snapshot.location, columns, theme),
    contextLine(snapshot, theme),
    ...compactionLines(snapshot.compactions, theme),
    quotaLine(snapshot, theme),
    ...agentSummaryLines(snapshot.agents, view === 'details', theme),
    ...(view === 'details' ? agentLines(snapshot.agents, theme) : []),
  ];
  return core.map(line => bounded(line, columns));
}
