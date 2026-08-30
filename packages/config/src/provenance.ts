import type { ProvenanceEntry } from './types.js';
export function jsonPointer(...segments: string[]): string {
  return '/' + segments.map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}
export function sortProvenance(items: ProvenanceEntry[]): ProvenanceEntry[] {
  return [...items].sort(
    (a, b) => a.pointer.localeCompare(b.pointer) || a.source.localeCompare(b.source),
  );
}
