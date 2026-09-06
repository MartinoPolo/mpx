/**
 * VENDOR EDIT (mpx-pi): keeps background completion notifications retractable
 * until the parent run settles.
 */
export interface ConsumableNotification {
  id: string;
  resultConsumed?: boolean;
}

type ParentRunEvent = 'agent_start' | 'agent_settled';
type RegisterParentRunHook = (event: ParentRunEvent, handler: () => void) => void;

interface PendingNotification {
  isUnread: () => boolean;
  send: (triggerTurn: boolean) => void;
}

export function registerParentRunNotificationGate(
  registerHook: RegisterParentRunHook,
): ParentRunNotificationGate {
  const gate = new ParentRunNotificationGate();
  registerHook('agent_start', () => gate.onParentAgentStart());
  registerHook('agent_settled', () => gate.onParentAgentSettled());
  return gate;
}

export class ParentRunNotificationGate {
  private readonly pendingNotifications = new Map<string, PendingNotification>();
  private parentRunActive = false;
  private backgroundAgentsActive = false;
  private disposed = false;

  scheduleIndividual<T extends ConsumableNotification>(
    record: T,
    send: (unread: T, triggerTurn: boolean) => void,
  ): void {
    this.schedule(record.id, {
      isUnread: () => !record.resultConsumed,
      send: (triggerTurn) => send(record, triggerTurn),
    });
  }

  scheduleGroup<T extends ConsumableNotification>(
    key: string,
    records: T[],
    send: (unread: T[], triggerTurn: boolean) => void,
  ): void {
    this.schedule(key, {
      isUnread: () => records.some((record) => !record.resultConsumed),
      send: (triggerTurn) => {
        const unread = records.filter((record) => !record.resultConsumed);
        if (unread.length > 0) {
          send(unread, triggerTurn);
        }
      },
    });
  }

  consume<T extends ConsumableNotification>(record: T): void {
    record.resultConsumed = true;
    this.pendingNotifications.delete(record.id);
  }

  onParentAgentStart(): void {
    if (!this.disposed) {
      this.parentRunActive = true;
    }
  }

  onParentAgentSettled(): void {
    if (this.disposed) {
      return;
    }

    this.parentRunActive = false;
    this.flushIfReady();
  }

  onBackgroundAgentsActiveChanged(active: boolean): void {
    if (this.disposed) {
      return;
    }
    this.backgroundAgentsActive = active;
    this.flushIfReady();
  }

  dispose(): void {
    this.disposed = true;
    this.pendingNotifications.clear();
  }

  private schedule(key: string, notification: PendingNotification): void {
    if (this.disposed) {
      return;
    }

    this.pendingNotifications.set(key, notification);
    this.flushIfReady();
  }

  private flushIfReady(): void {
    if (this.parentRunActive || this.backgroundAgentsActive) {
      return;
    }

    const unreadNotifications = [...this.pendingNotifications.values()].filter((notification) =>
      notification.isUnread(),
    );
    this.pendingNotifications.clear();
    for (const [index, notification] of unreadNotifications.entries()) {
      this.deliver(notification, index === unreadNotifications.length - 1);
    }
  }

  private deliver(notification: PendingNotification, triggerTurn: boolean): void {
    try {
      notification.send(triggerTurn);
    } catch {
      // Completion notifications are best-effort side effects.
    }
  }
}
