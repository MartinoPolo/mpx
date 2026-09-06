import { DEV_SERVERS_CHANGED_EVENT, type DevServerSnapshot } from './contract.js';

export type ManagedFooterTone = 'warning' | 'success' | 'error' | 'dim';

export type ManagedFooterSnapshot = Pick<DevServerSnapshot, 'id' | 'state' | 'exitCode'>;

export interface ManagedFooterSegment {
  readonly text: string;
  readonly tone: ManagedFooterTone;
}

interface ManagedDevServerEventSource {
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

export function subscribeManagedDevServerEvents(
  events: ManagedDevServerEventSource,
  onSnapshot: (snapshot: ManagedFooterSnapshot) => void,
): () => void {
  return events.on(DEV_SERVERS_CHANGED_EVENT, (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') {
      return;
    }
    const value = payload as Record<string, unknown>;
    if (
      typeof value.id !== 'string' ||
      !['starting', 'ready', 'crashed', 'stopped'].includes(String(value.state))
    ) {
      return;
    }
    onSnapshot({
      id: value.id,
      state: value.state as ManagedFooterSnapshot['state'],
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    });
  });
}

export function formatManagedDevServer(snapshot: ManagedFooterSnapshot): ManagedFooterSegment {
  if (snapshot.state === 'starting') {
    return { text: `${snapshot.id} starting`, tone: 'warning' };
  }
  if (snapshot.state === 'ready') {
    return { text: `${snapshot.id} ready`, tone: 'success' };
  }
  if (snapshot.state === 'crashed') {
    const exit = snapshot.exitCode === null ? '' : ` exit ${snapshot.exitCode}`;
    return { text: `${snapshot.id} crashed${exit}`, tone: 'error' };
  }
  return { text: `${snapshot.id} stopped`, tone: 'dim' };
}
