import { isNonNegativeInt } from './statusline-ansi.js';

export const COMPLETED = 'completed';
export const AGENT_TYPE_ROWS = 6;
export const AGENT_DETAIL_ROWS = 5;

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.trunc(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    return `${Math.trunc(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`;
  }
  const minutes = Math.trunc((totalSeconds % 3600) / 60);
  return `${Math.trunc(totalSeconds / 3600)}h${String(minutes).padStart(2, '0')}m`;
}

export function formatTokens(value: string | number): string {
  if (isNonNegativeInt(value) && Number(value) >= 1000) {
    const rounded = Number(value) + 50;
    return `${Math.trunc(rounded / 1000)}.${Math.trunc((rounded % 1000) / 100)}k`;
  }
  const text = String(value);
  return text === '' ? '0' : text;
}

export interface CountedGroup {
  label: string;
  count: number;
  tokens: number;
  drifted: boolean;
}

export interface GroupMember {
  label: string;
  tokens: number;
  drifted: boolean;
}

export function countLabel(count: number, name: string): string {
  return `${count}×${name}`;
}

export function groupMembers(members: readonly GroupMember[]): CountedGroup[] {
  const groups = new Map<string, CountedGroup>();
  for (const member of members) {
    if (member.label === '') continue;
    const existing = groups.get(member.label);
    if (existing === undefined) {
      groups.set(member.label, { ...member, count: 1 });
    } else {
      existing.count += 1;
      existing.tokens += member.tokens;
      existing.drifted ||= member.drifted;
    }
  }
  return [...groups.values()];
}

export interface FinishedAgent {
  id: string;
  type: string;
  tier: string;
  effort: string;
  tokens: number;
  elapsedMs: number;
  status: string;
  drifted: boolean;
}

export function selectDetailRows(
  agents: readonly FinishedAgent[],
  cap: number = AGENT_DETAIL_ROWS,
): FinishedAgent[] {
  const broken = agents.filter((agent) => agent.status !== COMPLETED);
  const completed = agents.filter((agent) => agent.status === COMPLETED);
  if (agents.length <= cap) return [...broken, ...completed];
  const slots = Math.max(0, cap - broken.length);
  return [
    ...broken,
    ...[...completed].sort((left, right) => right.tokens - left.tokens).slice(0, slots),
  ];
}
