import { MpxError } from "@mpx/core";
import type { Agent, AgentLaunchRequest, AgentRunner, CompletionNotification, ScheduledAgent, ScheduleRequest } from "./contracts.js";
import type { StrictWorktreeIsolation } from "./isolation.js";

function fail(code: string, message: string): never { throw new MpxError({ code, message: `${code}: ${message}`, retryable: false }); }
class SteeringChannel implements AsyncIterable<string> {
  private values: string[] = []; private waiters: Array<(value: IteratorResult<string>) => void> = []; private closed = false;
  push(value: string): void { const waiter = this.waiters.shift(); if (waiter) waiter({ value, done: false }); else this.values.push(value); }
  close(): void { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<string> { return { next: async () => {
    const value = this.values.shift(); if (value !== undefined) return { value, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise(resolve => this.waiters.push(resolve));
  } }; }
}
interface Internal { request: AgentLaunchRequest; agent: Agent; abort: AbortController; steer: SteeringChannel; promise: Promise<void>; resolve: () => void }
interface Group { ids: Set<string>; notification: "idle" | "pending" | "delivered" | "failed" }
export interface SubagentLifecycleOptions {
  readonly concurrency: number;
  readonly runner: AgentRunner;
  readonly isolation?: StrictWorktreeIsolation;
  readonly now?: () => number;
  readonly notify?: (notification: CompletionNotification) => void | Promise<void>;
  readonly notificationRetries?: number;
  readonly onNotificationError?: (error: Error, notification: CompletionNotification, attempt: number) => void;
}

/** Provider-neutral state machine for foreground, background, grouped and async child runs. */
export class SubagentLifecycle {
  private readonly records = new Map<string, Internal>(); private readonly queue: string[] = []; private readonly groups = new Map<string, Group>(); private readonly schedules = new Map<string, ScheduledAgent>();
  private running = 0; private stopped = false; private readonly now: () => number;
  constructor(private readonly options: SubagentLifecycleOptions) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) fail("SUBAGENT_CONCURRENCY_INVALID", "Concurrency must be a positive safe integer.");
    if (options.notificationRetries !== undefined && (!Number.isSafeInteger(options.notificationRetries) || options.notificationRetries < 0 || options.notificationRetries > 10)) fail("SUBAGENT_NOTIFICATION_RETRIES_INVALID", "Notification retries must be from zero through ten.");
    this.now = options.now ?? Date.now;
  }
  async launch(request: AgentLaunchRequest): Promise<Agent> {
    if (this.stopped) fail("SUBAGENT_SHUTDOWN", "Subagent lifecycle is shut down.");
    if (this.records.has(request.id)) fail("SUBAGENT_ID_CONFLICT", "Subagent id already exists.");
    if (request.identity !== request.authority.identity.name || request.nesting.depth !== request.authority.nesting.depth || request.nesting.maxDepth !== request.authority.nesting.maxDepth) fail("SUBAGENT_AUTHORITY_MISMATCH", "Agent metadata does not match child launch authority.");
    const model = Object.freeze({ ...request.model }); const createdAt = this.now();
    let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
    const agent: Agent = Object.freeze({ id: request.id, type: request.type, identity: request.identity, description: request.description, join: request.join, ...(request.groupId ? { groupId: request.groupId } : {}), model, nesting: Object.freeze({ ...request.nesting }), authority: request.authority, status: "queued", createdAt, resultConsumed: request.join === "foreground" });
    this.records.set(request.id, { request: Object.freeze({ ...request, model }), agent, abort: new AbortController(), steer: new SteeringChannel(), promise, resolve }); this.queue.push(request.id); this.pump();
    if (request.join === "foreground") { await promise; return this.get(request.id); }
    return agent;
  }
  get(id: string): Agent { const found = this.records.get(id); if (!found) fail("SUBAGENT_NOT_FOUND", "Subagent does not exist."); return found.agent; }
  list(): readonly Agent[] { return Object.freeze([...this.records.values()].map(item => item.agent)); }
  async get_subagent_result(id: string): Promise<string> {
    const item = this.records.get(id); if (!item) fail("SUBAGENT_NOT_FOUND", "Subagent does not exist.");
    item.agent = Object.freeze({ ...item.agent, resultConsumed: true }); await item.promise;
    if (item.agent.status === "failed") fail("SUBAGENT_FAILED", item.agent.error ?? "Subagent failed.");
    return item.agent.result ?? "";
  }
  steer_subagent(id: string, message: string): void {
    if (!message.trim()) fail("SUBAGENT_STEER_INVALID", "Steering message is empty.");
    const item = this.records.get(id); if (!item || (item.agent.status !== "queued" && item.agent.status !== "running")) fail("SUBAGENT_NOT_RUNNING", "Only queued or running subagents can be steered.");
    item.steer.push(message);
  }
  registerGroup(groupId: string, ids: readonly string[]): void {
    if (!ids.length) fail("SUBAGENT_GROUP_EMPTY", "A group requires members.");
    const group: Group = { ids: new Set(ids), notification: "idle" }; this.groups.set(groupId, group);
    for (const id of ids) { const item = this.records.get(id); if (!item || item.request.groupId !== groupId) fail("SUBAGENT_GROUP_MISMATCH", "Group members must be launched with the same group id."); }
    this.maybeNotifyGroup(groupId);
  }
  cancel(id: string): void {
    const item = this.records.get(id); if (!item || (item.agent.status !== "queued" && item.agent.status !== "running")) return;
    if (item.agent.status === "queued") { const at = this.queue.indexOf(id); if (at >= 0) this.queue.splice(at, 1); this.finish(item, { error: "Cancelled" }); }
    else item.abort.abort(new Error("Cancelled"));
  }
  schedule(request: ScheduleRequest): ScheduledAgent {
    if (!request.explicitUserRequest) fail("SUBAGENT_SCHEDULE_EXPLICIT_REQUIRED", "Schedules are created only from an explicit user request.");
    if (this.schedules.has(request.id)) fail("SUBAGENT_SCHEDULE_CONFLICT", "Schedule id already exists.");
    const value = Object.freeze({ ...request, enabled: true, runCount: 0 }); this.schedules.set(request.id, value); return value;
  }
  restoreSchedules(values: readonly ScheduledAgent[]): void { if (this.stopped) fail("SUBAGENT_SHUTDOWN", "Cannot restore schedules after shutdown."); for (const value of values) if (value.explicitUserRequest && value.enabled) this.schedules.set(value.id, Object.freeze({ ...value })); }
  snapshotSchedules(): readonly ScheduledAgent[] { return Object.freeze([...this.schedules.values()]); }
  async processDue(at = this.now()): Promise<void> {
    for (const [id, scheduled] of [...this.schedules]) {
      if (!scheduled.enabled || scheduled.nextRunAt > at) continue;
      const launch = { ...scheduled.launch, id: `${scheduled.launch.id}-${scheduled.runCount + 1}` };
      await this.launch(launch); const next = scheduled.intervalMs === undefined ? { ...scheduled, enabled: false, runCount: scheduled.runCount + 1, lastRunAt: at } : { ...scheduled, nextRunAt: at + scheduled.intervalMs, runCount: scheduled.runCount + 1, lastRunAt: at };
      this.schedules.set(id, Object.freeze(next));
    }
  }
  async shutdown(): Promise<readonly ScheduledAgent[]> {
    this.stopped = true; for (const item of this.records.values()) if (item.agent.status === "queued" || item.agent.status === "running") this.cancel(item.agent.id);
    await Promise.all([...this.records.values()].map(item => item.promise)); return this.snapshotSchedules();
  }
  private pump(): void { while (!this.stopped && this.running < this.options.concurrency && this.queue.length) { const id = this.queue.shift()!; const item = this.records.get(id)!; this.running++; void this.execute(item); } }
  private async execute(item: Internal): Promise<void> {
    item.agent = Object.freeze({ ...item.agent, status: "running", startedAt: this.now() }); let cwd = item.request.isolation?.cwd ?? "."; let isolated: Awaited<ReturnType<StrictWorktreeIsolation["create"]>> | undefined; let result = ""; let primaryError: string | undefined;
    try {
      if (item.request.isolation) { if (!this.options.isolation) fail("SUBAGENT_ISOLATION_UNAVAILABLE", "Strict worktree isolation is unavailable."); isolated = await this.options.isolation.create(item.request.isolation); cwd = isolated.cwd; }
      result = await this.options.runner.run(item.request, { cwd, signal: item.abort.signal, steer: item.steer });
    } catch (error) { primaryError = error instanceof Error ? error.message : String(error); }
    finally {
      try {
        let cleanupError: string | undefined;
        if (isolated) try { await this.options.isolation!.cleanup(isolated); }
        catch (error) { cleanupError = error instanceof Error ? error.message : String(error); }
        const error = primaryError === undefined ? cleanupError : cleanupError === undefined ? primaryError : `${primaryError} (cleanup also failed: ${cleanupError})`;
        this.finish(item, error === undefined ? { result } : { error });
      } finally { item.steer.close(); this.running--; this.pump(); }
    }
  }
  private finish(item: Internal, outcome: { result?: string; error?: string }): void {
    if (item.agent.status === "completed" || item.agent.status === "failed") return;
    item.agent = Object.freeze({ ...item.agent, status: outcome.error === undefined ? "completed" : "failed", completedAt: this.now(), ...(outcome.result === undefined ? {} : { result: outcome.result }), ...(outcome.error === undefined ? {} : { error: outcome.error }) }); item.resolve();
    if (item.request.groupId) this.maybeNotifyGroup(item.request.groupId); else if (!item.agent.resultConsumed && item.request.join !== "foreground") void this.deliverNotification({ agents: [item.agent], partial: false });
  }
  private async deliverNotification(notification: CompletionNotification): Promise<boolean> {
    if (!this.options.notify) return true;
    const attempts=(this.options.notificationRetries??0)+1;
    for(let attempt=1;attempt<=attempts;attempt++)try{await this.options.notify(notification);return true}catch(reason){const error=reason instanceof Error?reason:new Error(String(reason));try{this.options.onNotificationError?.(error,notification,attempt)}catch{/* Error reporting must not corrupt lifecycle completion. */}}
    return false;
  }
  private maybeNotifyGroup(groupId: string): void {
    const group = this.groups.get(groupId); if (!group || group.notification !== "idle") return;
    const terminal = [...group.ids].map(id => this.records.get(id)?.agent).filter((agent): agent is Agent => agent !== undefined && (agent.status === "completed" || agent.status === "failed"));
    if (terminal.length !== group.ids.size) return;
    const unread = terminal.filter(agent => !agent.resultConsumed); if (!unread.length){group.notification="delivered";return}
    group.notification="pending";void this.deliverNotification({agents:unread,partial:false}).then(delivered=>{group.notification=delivered?"delivered":"failed";});
  }
}
