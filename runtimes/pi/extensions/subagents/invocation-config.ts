import type { AgentConfig, AgentInvocation, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";

export interface InvocationModel {
  provider: string;
  id: string;
}

/** VENDOR EDIT (mpx-pi): Keep the actual resolved model ID on every UI snapshot. */
export function getResolvedModelName(model: InvocationModel | undefined): string | undefined {
  return model?.id;
}

/** VENDOR EDIT (mpx-pi): Normalize model display centrally for every spawn path. */
export function withResolvedModelName(
  invocation: AgentInvocation | undefined,
  model: InvocationModel | undefined,
): AgentInvocation {
  return { ...invocation, modelName: getResolvedModelName(model) };
}

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: agentConfig?.isolation ?? params.isolation,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
