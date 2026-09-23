import type { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { colorAgentModel, shortModel, thinkingGauge, type FooterAgent } from './pi-footer.js';

export const LIVE_AGENT_WIDGET = 'mpx-live-agents';
const MAX_VISIBLE_LIVE_AGENTS = 5;
const LIVE_STATUSES = new Set(['running', 'queued']);

export interface LiveAgent {
  id: string;
  type: string;
  description?: string;
  status: 'running' | 'queued';
  model?: string;
  effort?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function finishedAgentFromRecord(value: unknown, sessionId: string): FooterAgent | undefined {
  const source = object(value);
  const id = text(source?.id);
  const type = text(source?.type);
  const status = text(source?.status);
  if (!source || !id || !type || !status || source.parentSessionId !== sessionId
    || source.parentAgentId !== undefined || source.workflowId !== undefined) return undefined;
  const invocation = object(source.invocation);
  const usage = object(source.lifetimeUsage);
  const cost = amount(usage?.cost);
  const startedAt = amount(source.startedAt);
  const completedAt = amount(source.completedAt);
  const sessionFile = text(source.sessionFile);
  return {
    id, type, status: LIVE_STATUSES.has(status) ? 'stopped' : status,
    model: text(invocation?.modelId) ?? text(invocation?.modelName),
    effort: text(invocation?.thinking),
    // Upstream initializes missing pricing to zero, so only a positive estimate is trustworthy.
    ...(cost !== undefined && cost > 0 ? { cost } : {}),
    ...(startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
      ? { elapsedMs: completedAt - startedAt } : {}),
    ...(sessionFile && path.isAbsolute(sessionFile) ? { url: pathToFileURL(sessionFile).href } : {}),
  };
}

export function savedFinishedAgents(entries: readonly unknown[], sessionId: string): FooterAgent[] {
  const agents = new Map<string, FooterAgent>();
  for (const entry of entries) {
    const source = object(entry);
    if (source?.type !== 'custom' || source.customType !== 'subagents:record') continue;
    const agent = finishedAgentFromRecord(source.data, sessionId);
    if (agent) agents.set(agent.id, agent);
  }
  return [...agents.values()];
}

export function renderLiveAgents(agents: readonly LiveAgent[], width: number, theme: Pick<Theme, 'fg'>): string[] {
  if (!agents.length || !Number.isFinite(width) || width <= 0) return [];
  const clean = (value: string) => stripTerminalSequences(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const running = agents.filter(agent => agent.status === 'running');
  const queued = agents.length - running.length;
  const rows = [theme.fg('muted', `Agents · ${running.length} running${queued ? ` · ${queued} queued` : ''}`)];
  for (const agent of running.slice(0, MAX_VISIBLE_LIVE_AGENTS)) {
    const details = [colorAgentModel(agent.model, clean(agent.type), theme),
      ...(agent.model ? [colorAgentModel(agent.model, shortModel(agent.model), theme)] : []),
      ...(agent.effort ? [thinkingGauge(agent.effort)] : []), ...(agent.description ? [clean(agent.description)] : [])];
    rows.push(`${theme.fg('accent', '●')} ${details.join(' · ')}`);
  }
  if (running.length > MAX_VISIBLE_LIVE_AGENTS) rows.push(theme.fg('dim', `… ${running.length - MAX_VISIBLE_LIVE_AGENTS} more running`));
  return rows.map(row => truncateToWidth(row, Math.floor(width), '…'));
}
