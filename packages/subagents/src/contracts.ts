import type { ChildLaunchAuthorityV1 } from "@mpx/runtime-contracts";

export type AgentStatus = "queued" | "running" | "completed" | "failed";
export type JoinMode = "foreground" | "background" | "group" | "async";
export type MemoryScope = "user" | "project" | "local";

export interface ResolvedModelSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
}
export interface NestingMetadata {
  readonly depth: number;
  readonly maxDepth: number;
  readonly parentAgentId: string | null;
  readonly rootAgentId: string;
}
export interface Agent {
  readonly id: string;
  readonly type: string;
  readonly identity: string;
  readonly description: string;
  readonly join: JoinMode;
  readonly groupId?: string;
  readonly model: ResolvedModelSnapshot;
  readonly nesting: NestingMetadata;
  readonly authority: ChildLaunchAuthorityV1;
  readonly status: AgentStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly result?: string;
  readonly error?: string;
  readonly resultConsumed: boolean;
}
export interface AgentLaunchRequest {
  readonly id: string;
  readonly type: string;
  readonly identity: string;
  readonly description: string;
  readonly prompt: string;
  readonly join: JoinMode;
  readonly groupId?: string;
  readonly model: ResolvedModelSnapshot;
  readonly nesting: NestingMetadata;
  readonly authority: ChildLaunchAuthorityV1;
  readonly isolation?: { readonly cwd: string; readonly branch: string; readonly base?: string };
}
export interface AgentRunner {
  run(request: AgentLaunchRequest, context: { readonly cwd: string; readonly signal: AbortSignal; readonly steer: AsyncIterable<string> }): Promise<string>;
}
export interface CompletionNotification {
  readonly agents: readonly Agent[];
  readonly partial: boolean;
}
export interface ScheduleRequest {
  readonly id: string;
  readonly explicitUserRequest: boolean;
  readonly launch: AgentLaunchRequest;
  readonly nextRunAt: number;
  readonly intervalMs?: number;
}
export interface ScheduledAgent extends ScheduleRequest {
  readonly enabled: boolean;
  readonly runCount: number;
  readonly lastRunAt?: number;
}
