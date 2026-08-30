import {
  createRuntimeStatusRefreshController,
  projectRuntimeStatusEnvelopeV1,
  type RuntimeStatusEnvelopeReader,
  type RuntimeStatusEnvelopeV1,
  type RuntimeStatusProjectionV1,
} from '@mpx/status';

function compact(value: number | null): string {
  if (value === null) {
    return '?';
  }
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}k`;
  }
  return String(value);
}
function group(parts: string[], value: string | null | undefined): void {
  if (value) {
    parts.push(value);
  }
}

/** Pure renderer over a privacy-filtered immutable status projection. It performs no I/O or credential decoding. */
export function renderPiRuntimeStatus(
  value: RuntimeStatusEnvelopeV1,
  width: 'narrow' | 'wide',
): string {
  const status: RuntimeStatusProjectionV1 = projectRuntimeStatusEnvelopeV1(value, width);
  const parts: string[] = [];
  group(parts, status.identity.label);
  group(parts, status.model.label ?? status.model.modelId);
  if (status.repository.name) {
    group(
      parts,
      `${status.repository.name}${status.repository.branch ? `@${status.repository.branch}` : ''}${status.repository.dirty ? '*' : ''}`,
    );
  }
  if (status.model.contextUsedTokens !== null || status.model.contextLimitTokens !== null) {
    group(
      parts,
      `${compact(status.model.contextUsedTokens)}/${compact(status.model.contextLimitTokens)}`,
    );
  }
  group(
    parts,
    status.cost.amountMicros === null
      ? null
      : `$${(status.cost.amountMicros / 1_000_000).toFixed(2)}`,
  );
  if (status.providerUsage.used !== null || status.providerUsage.limit !== null) {
    group(
      parts,
      `quota ${compact(status.providerUsage.used)}/${compact(status.providerUsage.limit)}${status.providerUsage.unit === 'percent' ? '%' : ''}`,
    );
  }
  group(parts, status.compactions.count === null ? null : `cmp ${status.compactions.count}`);
  if (status.subagents.active !== null || status.subagents.completed !== null) {
    group(
      parts,
      `agents ${compact(status.subagents.active)}/${compact(status.subagents.completed)}`,
    );
  }
  for (const service of status.development.services) {
    group(parts, `${service.id}:${service.port ?? '?'}${service.state === 'conflict' ? '!' : ''}`);
  }
  for (const action of status.actions) {
    if (action.enabled) {
      group(parts, action.label);
    }
  }
  return parts.join(' · ');
}

export interface PiRuntimeStatusAdapter {
  current(): RuntimeStatusEnvelopeV1 | undefined;
  refresh(): Promise<void>;
  render(width: 'narrow' | 'wide'): string;
  abort(): void;
}
/** Async producer/cache. Footer render remains synchronous and never reads files, auth, JWTs, or account state. */
export function createPiRuntimeStatusAdapter(
  reader: RuntimeStatusEnvelopeReader,
): PiRuntimeStatusAdapter {
  const controller = createRuntimeStatusRefreshController(reader);
  return {
    current: controller.current,
    refresh: controller.refresh,
    abort: controller.abort,
    render(width) {
      const value = controller.current();
      return value ? renderPiRuntimeStatus(value, width) : '';
    },
  };
}
