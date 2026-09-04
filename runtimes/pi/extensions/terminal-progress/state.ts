export const IDLE_SEQUENCE = '\x1b]9;4;0;0\x07';
export const WORKING_SEQUENCE = '\x1b]9;4;3;0\x07';
export const ATTENTION_SEQUENCE = '\x1b]9;4;4;100\x07';

interface TimerHandle {
  unref?: () => void;
}

export interface TerminalProgressDependencies {
  write: (sequence: string) => void;
  setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearInterval?: (timer: TimerHandle) => void;
}

export class TerminalProgressController {
  private readonly write: (sequence: string) => void;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly timer: TimerHandle;
  private agentWorking = false;
  private blocked = false;
  private readonly questionCalls = new Set<string>();
  private sequence = IDLE_SEQUENCE;
  private disposed = false;

  constructor(dependencies: TerminalProgressDependencies) {
    this.write = dependencies.write;
    const createTimer = dependencies.setInterval ?? globalThis.setInterval;
    this.clearTimer =
      dependencies.clearInterval ??
      ((timer) => {
        globalThis.clearInterval(timer as ReturnType<typeof globalThis.setInterval>);
      });
    this.write(this.sequence);
    this.timer = createTimer(() => this.keepalive(), 1_000);
    this.timer.unref?.();
  }

  get currentSequence(): string {
    return this.sequence;
  }

  onAgentStart(): void {
    if (this.disposed) return;
    this.agentWorking = true;
    this.update();
  }

  onAgentSettled(): void {
    if (this.disposed) return;
    this.agentWorking = false;
    this.update();
  }

  onBlocked(active: boolean): void {
    if (this.disposed) return;
    this.blocked = active;
    this.update();
  }

  onQuestionStart(toolCallId: string): void {
    if (this.disposed) return;
    this.questionCalls.add(toolCallId);
    this.update();
  }

  onQuestionEnd(toolCallId: string): void {
    if (this.disposed) return;
    this.questionCalls.delete(toolCallId);
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer(this.timer);
    if (this.sequence !== IDLE_SEQUENCE) {
      this.sequence = IDLE_SEQUENCE;
      this.write(this.sequence);
    }
  }

  private keepalive(): void {
    if (!this.disposed && this.sequence !== IDLE_SEQUENCE) {
      this.write(this.sequence);
    }
  }

  private update(): void {
    if (this.disposed) return;
    const next =
      this.blocked || this.questionCalls.size > 0
        ? ATTENTION_SEQUENCE
        : this.agentWorking
          ? WORKING_SEQUENCE
          : IDLE_SEQUENCE;
    if (next === this.sequence) return;
    this.sequence = next;
    this.write(next);
  }
}
