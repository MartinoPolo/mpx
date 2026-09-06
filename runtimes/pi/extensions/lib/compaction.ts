/** Rows of compaction history shown before the rest collapse into a count. */
export const COMPACTION_ROWS = 3;

/** `227148` -> `227k`, right-aligned so token changes align. */
export function formatTokensK(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`.padStart(4);
}

/** ISO-8601 -> local `HH:MM`. */
export function formatClock(timestamp: string): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
