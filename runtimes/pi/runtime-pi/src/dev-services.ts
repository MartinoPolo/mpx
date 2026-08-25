import type { ExecutorKind, StartRequest } from "@mpx/dev-services";

export interface DevServerLaunchBinding { readonly launchKey: string; readonly worktree: string; readonly ports: readonly number[]; readonly executor: ExecutorKind }
export interface DevServerStartInput { readonly launchKey: string; readonly id: string; readonly executable: string; readonly args: readonly string[]; readonly cwd: string }
export interface DevServerDependencies {
  start(request: StartRequest): Promise<unknown>;
  shutdown(): Promise<void>;
  publish(event: Readonly<Record<string, unknown>>): void;
}
export interface LaunchBoundDevServer { start(input: DevServerStartInput): Promise<unknown>; cleanup(): Promise<void> }

/** Binds every service operation to the immutable launch assignment. Executor errors are propagated; Docker never falls back to host. */
export function createLaunchBoundDevServer(binding: DevServerLaunchBinding, dependencies: DevServerDependencies): LaunchBoundDevServer {
  const launch = Object.freeze({ ...binding, ports: Object.freeze([...binding.ports]) });
  return Object.freeze({
    async start(input: DevServerStartInput) {
      if (input.launchKey !== launch.launchKey) throw new Error("DEV_SERVER_LAUNCH_STALE: service request belongs to another launch");
      const request: StartRequest = { id: input.id, executable: input.executable, args: [...input.args], cwd: input.cwd, ports: [...launch.ports], assignment: { worktreeRoot: launch.worktree, ports: [...launch.ports] }, executor: launch.executor };
      const result = await dependencies.start(request);
      dependencies.publish(Object.freeze({ type: "dev-server:status", launchKey: launch.launchKey, serviceId: input.id, result }));
      return result;
    },
    async cleanup() { await dependencies.shutdown(); dependencies.publish(Object.freeze({ type: "dev-server:cleanup", launchKey: launch.launchKey })); },
  });
}
