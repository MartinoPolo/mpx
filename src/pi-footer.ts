import type { Theme } from '@earendil-works/pi-coding-agent';
import { hyperlink, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export type FooterView = 'compact' | 'summary' | 'details';

export interface FooterLayoutState {
  view: FooterView;
  historyExpanded: boolean;
  expandedGroups: ReadonlySet<string>;
}

type FooterControlPosition = {
  row: number;
  startColumn: number;
  endColumn: number;
};

type FooterControlKind =
  | { kind: 'footer' }
  | { kind: 'history' }
  | { kind: 'group'; groupKey: string };

export type FooterControl = FooterControlPosition & FooterControlKind;
type FooterControlTarget = Omit<FooterControlPosition, 'row'> & FooterControlKind;

export interface FooterLayout {
  lines: string[];
  controls: FooterControl[];
}

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
  peakInputTokens?: number;
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
const MAX_AGENTS = 10;
const ELAPSED_FIELD_WIDTH = 7;
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

export function shortModel(value: string | undefined): string {
  const model = modelIdentifier(value);
  const versioned = model.match(/^(?:gpt|codex)-(\d+(?:\.\d+)*)-(astra|luna|sol|terra)$/i);
  return versioned ? `${versioned[2]![0]!.toUpperCase()}${versioned[2]!.slice(1).toLowerCase()} ${versioned[1]}` : model;
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
  const leftPeak = finite(left.peakInputTokens) && left.peakInputTokens >= 0 ? left.peakInputTokens : undefined;
  const rightPeak = finite(right.peakInputTokens) && right.peakInputTokens >= 0 ? right.peakInputTokens : undefined;
  if (leftPeak === undefined || rightPeak === undefined) {
    if (leftPeak !== undefined) return -1;
    if (rightPeak !== undefined) return 1;
  } else if (leftPeak !== rightPeak) return rightPeak - leftPeak;
  return safeText(left.id).localeCompare(safeText(right.id));
}

type AgentGroup = {
  key: string;
  identifier: string;
  model: string;
  effort: string;
  agents: FooterAgent[];
  summedPeakInputTokens: number;
  largestPeakInputTokens: number;
  peakCount: number;
  cost: number;
  costCount: number;
};

function agentGroups(agents: readonly FooterAgent[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const agent of finishedAgents(agents)) {
    const identifier = modelIdentifier(agent.model);
    const model = shortModel(agent.model);
    const effort = safeText(agent.effort, '<unknown>').toLowerCase();
    const key = `${identifier}\u0000${effort}`;
    const group = groups.get(key) ?? {
      key, identifier, model, effort, agents: [], summedPeakInputTokens: 0, largestPeakInputTokens: 0,
      peakCount: 0, cost: 0, costCount: 0,
    };
    group.agents.push(agent);
    if (finite(agent.peakInputTokens) && agent.peakInputTokens >= 0) {
      group.summedPeakInputTokens += agent.peakInputTokens;
      group.largestPeakInputTokens = Math.max(group.largestPeakInputTokens, agent.peakInputTokens);
      group.peakCount++;
    }
    if (finite(agent.cost) && agent.cost >= 0) { group.cost += agent.cost; group.costCount++; }
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    const leftFullyPriced = left.costCount === left.agents.length;
    const rightFullyPriced = right.costCount === right.agents.length;
    if (leftFullyPriced !== rightFullyPriced) return leftFullyPriced ? -1 : 1;
    if (leftFullyPriced && rightFullyPriced && left.cost !== right.cost) return right.cost - left.cost;
    return right.summedPeakInputTokens - left.summedPeakInputTokens || left.identifier.localeCompare(right.identifier) || left.effort.localeCompare(right.effort);
  });
}

function aggregateMetrics(group: AgentGroup): string[] {
  const count = group.agents.length;
  const partialLabel = group.peakCount > 0 && group.peakCount < count ? ' known' : '';
  const summedPeaks = group.peakCount ? `${formatTokenCount(group.summedPeakInputTokens)}${partialLabel}` : '—';
  const largestPeak = group.peakCount ? `${formatTokenCount(group.largestPeakInputTokens)}${partialLabel}` : '—';
  const peaks = count === 1 ? summedPeaks : `${summedPeaks} (${largestPeak})`;
  const cost = group.costCount === count ? `$${group.cost.toFixed(3)}`
    : group.costCount ? `$${group.cost.toFixed(3)} known cost` : 'cost unavailable';
  return [`×${count}`, peaks, cost];
}

function agentDetailLines(group: AgentGroup, theme: FooterTheme): string[] {
  const ordered = [...group.agents].sort(compareAgents);
  const visible = ordered.slice(0, MAX_AGENTS);
  const rows: string[] = [];
  for (const agent of visible) {
    const glyph = agentGlyph(safeText(agent.status));
    const color = glyph === '✓' ? 'success' : glyph === '■' ? 'warning' : 'error';
    const model = shortModel(agent.model);
    const effort = safeText(agent.effort, '<unknown>');
    const elapsed = bounded(
      finite(agent.elapsedMs) && agent.elapsedMs >= 0 ? duration(agent.elapsedMs) : 'unknown',
      ELAPSED_FIELD_WIDTH,
    ).padEnd(ELAPSED_FIELD_WIDTH);
    const metrics = [
      finite(agent.peakInputTokens) && agent.peakInputTokens >= 0 ? formatTokenCount(agent.peakInputTokens) : '—',
      finite(agent.cost) && agent.cost >= 0 ? `$${agent.cost.toFixed(3)}` : undefined,
    ].filter((value): value is string => value !== undefined);
    const text = [`${theme.fg(color, glyph)} ${colorAgentModel(agent.model, safeText(agent.type), theme)}`, colorAgentModel(agent.model, model, theme), thinkingGauge(effort), elapsed, ...metrics].join(footerSeparator(theme));
    rows.push(`    ${linked(text, agent.url)}`);
  }
  if (ordered.length > visible.length) rows.push(theme.fg('dim', `    … ${ordered.length - visible.length} more agents`));
  return rows;
}

function compactHistoryLine(groups: readonly AgentGroup[], theme: FooterTheme): string {
  const agentCount = groups.reduce((sum, group) => sum + group.agents.length, 0);
  const knownCost = groups.reduce((sum, group) => sum + group.cost, 0);
  const knownCostCount = groups.reduce((sum, group) => sum + group.costCount, 0);
  const cost = knownCostCount === agentCount ? `$${knownCost.toFixed(3)}`
    : knownCostCount ? `$${knownCost.toFixed(3)} known cost` : 'cost unavailable';
  const modelCounts = new Map<string, { identifier: string; model: string; count: number }>();
  for (const group of groups) {
    const current = modelCounts.get(group.identifier) ?? { identifier: group.identifier, model: group.model, count: 0 };
    current.count += group.agents.length;
    modelCounts.set(group.identifier, current);
  }
  const models = [...modelCounts.values()].sort((left, right) => left.identifier.localeCompare(right.identifier));
  const counts = models.map(model => {
    const collision = models.some(other => other.identifier !== model.identifier && other.model === model.model);
    const label = collision ? model.identifier : model.model;
    return `${colorAgentModel(model.identifier, label, theme)} ×${model.count}`;
  });
  return [`▸ History (${agentCount})`, cost, ...counts].join(footerSeparator(theme));
}

const DEFAULT_LAYOUT_STATE: FooterLayoutState = {
  view: 'summary', historyExpanded: true, expandedGroups: new Set<string>(),
};

export function renderPiFooterLayout(
  snapshot: FooterSnapshot,
  width: number,
  theme: FooterTheme,
  state: FooterLayoutState = DEFAULT_LAYOUT_STATE,
): FooterLayout {
  if (!Number.isFinite(width) || width <= 0) return { lines: [], controls: [] };
  const columns = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  const controls: FooterControl[] = [];
  const addLine = (line: string, control?: FooterControlTarget) => {
    const row = lines.length;
    const lineWidth = visibleWidth(line);
    lines.push(bounded(line, columns));
    const retainedColumns = lineWidth <= columns ? columns : Math.max(0, columns - visibleWidth('…'));
    if (control && control.endColumn <= retainedColumns) controls.push({ ...control, row });
  };
  addLine(theme.fg('dim', '─'.repeat(columns)));
  if (state.view === 'compact') {
    const id = safeText(snapshot.sessionId, '').slice(0, 8) || 'unknown';
    addLine([
      theme.fg('dim', '▸'),
      linked(theme.fg('dim', `#${id}`), snapshot.sessionUrl),
      colorAgentModel(snapshot.model, shortModel(snapshot.model), theme),
      thinkingGauge(safeText(snapshot.effort, 'unknown').toLowerCase()),
      contextLine(snapshot, theme, false, false),
      quotaLine(snapshot, theme, false),
    ].join(footerSeparator(theme)), { kind: 'footer', startColumn: 0, endColumn: 1 });
    return { lines, controls };
  }
  addLine(`${theme.fg('dim', '▾')} ${sessionLine(snapshot, Math.max(1, columns - 2), theme)}`, { kind: 'footer', startColumn: 0, endColumn: 1 });
  addLine(modelLine(snapshot, columns, theme));
  addLine(locationLine(snapshot.location, columns, theme));
  addLine(contextLine(snapshot, theme));
  for (const line of compactionLines(snapshot.compactions, theme)) addLine(line);
  addLine(quotaLine(snapshot, theme));

  const groups = agentGroups(snapshot.agents);
  if (!groups.length) return { lines, controls };
  if (!state.historyExpanded) {
    addLine(compactHistoryLine(groups, theme), { kind: 'history', startColumn: 0, endColumn: 1 });
    return { lines, controls };
  }
  const finishedCount = groups.reduce((count, group) => count + group.agents.length, 0);
  addLine(`▾ History (${finishedCount})`, { kind: 'history', startColumn: 0, endColumn: 1 });
  const summaryRows = groups.map(group => {
    const collidingAlias = groups.some(other => other.identifier !== group.identifier && other.model === group.model);
    const label = collidingAlias ? group.identifier : group.model;
    return [colorAgentModel(group.identifier, label, theme), thinkingGauge(group.effort), ...aggregateMetrics(group)];
  });
  const columnWidths = summaryRows[0]!.map((_, column) =>
    Math.max(...summaryRows.map(fields => visibleWidth(fields[column]!))),
  );
  for (const [index, group] of groups.entries()) {
    const expanded = state.view === 'details' || state.expandedGroups.has(group.key);
    const fields = summaryRows[index]!.map((field, column, row) =>
      column === row.length - 1 ? field : field + ' '.repeat(columnWidths[column]! - visibleWidth(field)),
    );
    const summary = `${expanded ? '▾' : '▸'} ${fields.join(footerSeparator(theme))}`;
    addLine(`  ${summary}`, { kind: 'group', startColumn: 2, endColumn: 3, groupKey: group.key });
    if (expanded) for (const line of agentDetailLines(group, theme)) addLine(line);
  }
  return { lines, controls };
}

export function renderPiFooter(snapshot: FooterSnapshot, width: number, theme: FooterTheme, view: FooterView = 'summary'): string[] {
  return renderPiFooterLayout(snapshot, width, theme, {
    view,
    historyExpanded: true,
    expandedGroups: new Set<string>(),
  }).lines;
}
