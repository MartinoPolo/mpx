/** Shared policy results. Transports present diagnostics without reinterpreting policy. */
export interface PolicyResult {
  decision: 'allow' | 'warn' | 'block';
  diagnostics: string[];
}
