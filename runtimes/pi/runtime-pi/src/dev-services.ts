import { createDevServerToolAdapter, createSystemRuntime, DevServiceManager, type DevServerToolAdapter, type ExecutorKind, type RuntimeAdapter, type StartRequest } from "@mpx/dev-services";

export interface DevServerLaunchBinding { readonly launchKey: string; readonly worktree: string; readonly ports: readonly number[]; readonly executor: ExecutorKind }
export interface DevServerStartInput { readonly launchKey: string; readonly id: string; readonly executable: string; readonly args: readonly string[]; readonly cwd: string }
export interface DevServerDependencies {
  start(request: StartRequest): Promise<unknown>;
  shutdown(): Promise<void>;
  publish(event: Readonly<Record<string, unknown>>): void;
}
export interface LaunchBoundDevServer { start(input: DevServerStartInput): Promise<unknown>; cleanup(): Promise<void> }
export interface PiDevServerCapabilityInput extends DevServerLaunchBinding { readonly services?:Readonly<Record<string,StartRequest>>; readonly runtimeAdapter?: RuntimeAdapter; readonly publish?: (event: Readonly<Record<string, unknown>>) => void }
export interface PiDevServerCapability { readonly tool: DevServerToolAdapter; readonly manager: DevServiceManager; readonly shutdown: () => Promise<void> }
/** Creates an isolated launch-owned dev_server tool. Docker requires an explicitly selected Docker adapter. */
export function createPiDevServerCapability(input: PiDevServerCapabilityInput): PiDevServerCapability {
  if (!/^[a-f0-9]{64}$/u.test(input.launchKey)) throw new Error("DEV_SERVER_BINDING_INVALID: dev_server requires the exact launch key");
  const adapter = input.runtimeAdapter ?? (input.executor === "host" ? createSystemRuntime() : undefined);
  if (!adapter) throw new Error("DOCKER_ADAPTER_REQUIRED: Docker dev_server cannot fall back to host");
  if (adapter.kind !== input.executor) throw new Error("EXECUTOR_MISMATCH: dev_server adapter differs from the selected executor");
  const manager = new DevServiceManager(adapter, event => input.publish?.(Object.freeze({ ...event, launchKey: input.launchKey })));
  const tool = createDevServerToolAdapter(manager, { launchKey: input.launchKey, services: input.services??{} });
  const shutdown = async () => { await manager.shutdown(); input.publish?.(Object.freeze({ type: "dev-server:shutdown", launchKey: input.launchKey })); };
  return Object.freeze({ tool, manager, shutdown });
}

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
