import type { PortResolutionState, StatusSnapshot } from './provider.js';
import { parseStatusSnapshot } from './snapshot.js';

export type PortSegmentMarker = '' | '*' | '!' | '?';

export interface PortSegmentService {
  readonly id: string;
  readonly port: number | null;
  readonly listening: boolean;
  readonly conflict: 'none' | 'external' | 'unknown';
  readonly marker: PortSegmentMarker;
}

export interface PortSegmentData {
  readonly resolution: PortResolutionState;
  readonly services: readonly PortSegmentService[];
}

function markerFor(service: StatusSnapshot['services'][number]): PortSegmentMarker {
  if (service.conflict === 'external') {
    return '!';
  }
  if (service.conflict === 'unknown') {
    return '?';
  }
  return service.listening ? '*' : '';
}

/** Creates stable, runtime-neutral current-worktree port data. */
export function normalizePortSegment(snapshot: StatusSnapshot): PortSegmentData {
  return {
    resolution: snapshot.portResolution,
    services: [...snapshot.services]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((service) => ({
        id: service.id,
        port: service.port,
        listening: service.listening,
        conflict: service.conflict,
        marker: markerFor(service),
      })),
  };
}

/** Applies the shared plain-text representation; runtimes may style the result around this API. */
export function formatPortSegment(segment: PortSegmentData): string {
  if (segment.resolution !== 'valid') {
    return `ports ${segment.resolution}`;
  }
  if (segment.services.length === 0) {
    return 'ports none';
  }
  return `ports ${segment.services.map((service) => `${service.id}:${service.port ?? '?'}${service.marker}`).join(' ')}`;
}

export function renderPortSegment(snapshot: StatusSnapshot): string {
  return formatPortSegment(normalizePortSegment(snapshot));
}

/** Validated Claude adapter entrypoint. Surrounding status-line UI remains runtime-specific. */
export function renderClaudePortSegment(value: unknown): string {
  return renderPortSegment(parseStatusSnapshot(value));
}

/** Validated Pi adapter entrypoint. Surrounding footer UI remains runtime-specific. */
export function renderPiPortSegment(value: unknown): string {
  return renderPortSegment(parseStatusSnapshot(value));
}
