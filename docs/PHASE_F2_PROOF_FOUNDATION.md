# Phase F2 host-Pi / sandbox-executor split

Phase F2 production routing, proof-runner evidence, and lifecycle support are implemented without performing a real container or authentication operation. This evidence is offline-only and does not claim live F2 runtime acceptance.

## Host/private boundary

For Docker launches, Pi's process, TUI, model connection, OAuth store, session and history stay on the host. `ExecutionService` launches that process only through its dedicated host-Pi process adapter. Account roots and `PI_CODING_AGENT_DIR` are therefore never sent to the selected Docker executor.

The CLI now owns a launch-private loopback RPC server for each verified Docker Pi launch. It materializes a mode-0600 state record containing only endpoint, random nonce, launch/identity, plan, inventory, and capability hashes; native account roots, OAuth, `auth.json`, and tokens never enter that record or RPC. The generated extension constructs `pi.mpxRuntimeAdapters.remoteExecutor` from the invocation-bound bridge configuration rather than relying on test injection. Frames are bounded NDJSON, nonce/peer/binding attested, replay protected, cancellable, and timeout bounded; shutdown is awaited and removes private state on success or process failure.

Before session start, `activatePiSandboxExecutor` atomically replaces the complete model-triggerable tool set. It reasserts the same exact set at `session_start` and before every agent turn. File operations, shell/process, Git, browser, MCP, web/content, development services, skill search/load and all child-agent operations are remote proxies. A Docker launch without replacement support, a launch-bound remote executor, or complete attestation fails closed; there is no native host fallback. Host execution remains a separate explicitly approved compatibility mode.

## Binding and privacy

`ProductionRemoteExecutorRegistry` binds a `SandboxHandle` to launch key, identity, plan, capability and the Phase F1 inventory digest. Requests are sequenced and hash-bound. Cross-identity use, stale/replaced handles, replay, result mismatch, inventory widening and child authority widening are denied. Child lifecycle requests retain the same Docker executor and parent binding through `ChildLaunchAuthorityV1` and can only narrow tools/resources/routes/mounts/destinations/skills/models and nesting.

Remote serialization rejects OAuth/authorization/token fields and values, account/native-root fields, `PI_CODING_AGENT_DIR`, `auth.json`, bearer values and token-shaped canaries. Sandbox plans expose only generated sandbox state and include negative VM-scan booleans. Native roots, credentials, opposite-domain roots, Docker sockets and Git common directories are protected mount boundaries.

## Proof-runner and lifecycle evidence

| Behavior | Evidence |
| --- | --- |
| Fake sandbox worker envelopes, routing, and fail-closed proof checks | `packages/executors/src/f2-proof-runner.ts` and its tests |
| Production launch-bound remote executor routing | `packages/executors/src/production-remote.ts` and its tests |
| Real CLI-owned private IPC lifecycle, attestation, replay, timeout, cancellation, and cleanup | `packages/executors/src/launch-private-bridge.ts` and `launch-private-bridge.test.ts` |
| Generated Pi bridge client and invocation-only bridge binding | `runtimes/pi/runtime-pi/src/launch-private-client.ts`, `planPiInvocation`, and invocation tests |
| Production CLI bridge construction from the Docker adapter's client | `apps/cli/src/launch-execution.ts` |
| Docker service spawn/readiness/loopback publication/inspect/logs/restart/stop | `packages/dev-services/src/docker-runtime.test.ts` |
| Exact executor, launch, worktree, and assigned-port binding; no host fallback or foreign kill | `packages/dev-services/src/docker-runtime.ts` and its tests |
| Cancellation/crash cleanup, orphan/daemon-restart recreation, and malicious resume rejection | `packages/executors/src/sandbox-resume.test.ts` |
| Exact worker/projection/mount/network/port/account/identity attach verification | `decideSandboxResume` in `packages/executors/src/sandbox-resume.ts` |
| Session-neutral launch resume gate and minimal resume persistence | `gateLaunchSandboxResume` and `SandboxResumeStore` |
| Clone VM Git / host-worktree host Git ownership | `buildSandboxPlanV1` tests |

Every attach mismatch returns `recreate`; the lifecycle has no patch operation. Resume state contains only sandbox/app names, launch/plan/inventory hashes, workspace/branch identity hashes, and the attestation digest.

## Inventory and generated checks

[`inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json`](inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json) is generated from the code-owned registry and now records all 53 top-level and child paths. Its `runtimeToolInventorySha256` binds remote tool-set attestation; its executor evidence digest binds proof to the implementation. Any registry or executor change invalidates prior evidence.

## Live evidence still required

Pinned standalone `sbx` client/daemon diagnostics, real VM mounts/network/port publication, account enrollment, daemon restart, authentication isolation, clone fetch/direct-provider delivery, and containment/bypass observations remain unexecuted. The launch-private bridge is production code with fake-worker end-to-end evidence; it does not by itself claim a live VM containment proof. Docker therefore does not become the default from this offline slice. Live sbx daemon/VM/auth attestation remains an installation gate and is not claimed here.
