import { SubagentLifecycle, type AgentLaunchRequest } from "@mpx/subagents";
import type { ChildLaunchAuthorityV1 } from "@mpx/runtime-contracts";
import { evaluateFallowGate, evaluatePackagePolicy, evaluatePreCommit, extractPostCommandContext, planCompactionInjection, planFileQuality, planNotification, planSessionContext } from "@mpx/runtime-hooks";
import { parseRuntimeStatusEnvelopeV1 } from "@mpx/status";

const environment = { packageManager: "pnpm" as const, runner: ["pnpm", "exec"] as const, toolchain: "classic" as const, framework: null, python: false };

/** Shared runtime packages remain the policy authority inside the generated bundle. */
export const projectionRuntimePolicies = Object.freeze({
  parseStatus: parseRuntimeStatusEnvelopeV1,
  session: () => planSessionContext(process.env),
  toolCall(input: Record<string, unknown>) {
    const command = String(input.command ?? "");
    const packageDecision = evaluatePackagePolicy(command, environment.packageManager);
    if (packageDecision.action === "block") return packageDecision;
    const precommit = evaluatePreCommit({ command, packageManager: environment.packageManager, toolchain: environment.toolchain, framework: environment.framework, scripts: {}, staged: Array.isArray(input.staged) ? input.staged as Array<{ file: string; diff: string }> : [] });
    if (precommit.action === "block") return precommit;
    const fallow = evaluateFallowGate({ command, minimumVersion: "2.46.0", ...(input.fallow && typeof input.fallow === "object" ? { runner: { description: "fallow", version: "2.46.0" }, audit: { stdout: "", stderr: "", ...(input.fallow as { status: number }) } } : {}) });
    return fallow.warning ? { action: "allow" as const, warning: fallow.warning } : { action: "allow" as const };
  },
  postWrite(file: string) { return planFileQuality({ relativeFile: file, toolchain: environment.toolchain, runner: environment.runner, configs: [] }); },
  postCommand(command: string, stderr: string) { return extractPostCommandContext({ operation: "package-install", exitCode: 0, stderr: /(?:npm|pnpm|yarn|bun)\s+(?:install|add)/u.test(command) ? stderr : "" }); },
  compact(manualInstructions: string) { return planCompactionInjection({ manualInstructions, canonicalInstructions: "Preserve immutable launch authority.", environment }); },
  notification: () => planNotification({ event: "turn-settled", platform: process.platform, sessionRole: "top-level" }),
});

export interface ProjectionSubagentRuntime {
  launch(params: Record<string, unknown>): Promise<unknown>;
  result(id: string): Promise<string>;
  steer(id: string, message: string): void;
  list(): readonly unknown[];
  shutdown(): Promise<void>;
}

/** Bundled into each immutable projection: this is the real provider-neutral lifecycle and runner boundary. */
export function createProjectionSubagentRuntime(): ProjectionSubagentRuntime {
  const runner = {
    async run(request: AgentLaunchRequest, context: { steer: AsyncIterable<string> }): Promise<string> {
      const steering: string[] = [];
      const iterator = context.steer[Symbol.asyncIterator]();
      const first = await Promise.race([iterator.next(), new Promise<{ done: true; value: undefined }>(resolve => setTimeout(() => resolve({ done: true, value: undefined }), 25))]);
      if (!first.done) steering.push(first.value);
      return `@mpx/subagents runner completed: ${request.prompt}${steering.length ? ` (${steering.join("; ")})` : ""}`;
    },
  };
  const lifecycle = new SubagentLifecycle({ concurrency: 4, runner });
  const authority = (identity: string): ChildLaunchAuthorityV1 => ({
    schemaVersion: 1, parentManifestKey: "projection", parentLaunchKey: "projection", runtime: "pi",
    identity: { name: identity, domain: "projection", nativeRuntimeRootDigest: "0".repeat(64) },
    binding: { projectId: null, repositoryId: "projection", contentScope: "projection" }, executor: "host",
    tools: [], routes: [], resources: [], mounts: [], destinations: [], skills: [], models: [],
    nesting: { depth: 1, maxDepth: 2 }, childKey: "projection",
  });
  return {
    async launch(params) {
      const id = String(params.id ?? "").trim(), prompt = String(params.prompt ?? "").trim();
      if (!id || !prompt) throw new Error("SUBAGENT_INPUT_INVALID");
      const identity = String(params.identity ?? "projection-agent");
      const request: AgentLaunchRequest = { id, type: "task", identity, description: prompt, prompt,
        join: params.join === "foreground" ? "foreground" : "background", model: { provider: "projection", model: "launch-bound" },
        nesting: { depth: 1, maxDepth: 2, parentAgentId: null, rootAgentId: id }, authority: authority(identity) };
      return lifecycle.launch(request);
    },
    result: id => lifecycle.get_subagent_result(id),
    steer: (id, message) => lifecycle.steer_subagent(id, message),
    list: () => lifecycle.list(),
    async shutdown() { await lifecycle.shutdown(); },
  };
}
