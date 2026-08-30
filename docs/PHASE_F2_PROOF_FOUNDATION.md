# Phase F2 host-Pi / sandbox-executor split

Phase F2 production routing, proof-runner evidence, and lifecycle support are implemented without performing a real container or authentication operation. This evidence is offline-only and does not claim live F2 runtime acceptance.

## Host/private boundary

For Docker launches, Pi's process, TUI, model connection, OAuth store, session and history stay on the host. `ExecutionService` launches that process only through its dedicated host-Pi process adapter. Account roots and `PI_CODING_AGENT_DIR` are therefore never sent to the selected Docker executor.

The CLI now owns a launch-private loopback RPC server for each verified Docker Pi launch. It materializes a mode-0600 state record containing only endpoint, random nonce, launch/identity, plan, inventory, and capability hashes; native account roots, OAuth, `auth.json`, and tokens never enter that record or RPC. The generated extension constructs `pi.mpxRuntimeAdapters.remoteExecutor` from the invocation-bound bridge configuration rather than relying on test injection. Frames are bounded NDJSON, nonce/peer/binding attested, replay protected, cancellable, and timeout bounded. Shutdown is awaited and removes private state on success or process failure; startup also closes the listener and removes its state directory after any listen, state-write, or ACL failure, leaving the selected port reusable.

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
| Built-in Claude, personal/work app partition, signed per-identity fixture evidence, content-addressed projection, Docker aggregate MCP/dev route, secret exclusion, mismatch, and teardown | `packages/executors/src/standalone-sbx-executor.test.ts` using `scripts/fake-sbx.mjs` |

Every attach mismatch returns `recreate`; the lifecycle has no patch operation. Resume state contains only sandbox/app names, launch/plan/inventory hashes, workspace/branch identity hashes, and the attestation digest.

## Inventory and generated checks

[`inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json`](inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json) is generated from the code-owned registry and now records all 53 top-level and child paths. Its `runtimeToolInventorySha256` binds remote tool-set attestation; its executor evidence digest binds the declared executor evidence source. It does not bind every executor-related implementation file. Changes to a bound registry or declared evidence source invalidate prior evidence.

## Export-first live proof authority

A live run is authorized by a reviewed `SbxLaunchPlanExportV1`, never a bare `planKey` or the caller's current directory. The human supplies project, runtime, identity, workspace/policy overrides, the exported file, its exact canonical export key, `-ConfirmLive`, and the phrase `RUN MPX F2 LIVE PROOF`. The runner validates packaged pin, inventory, and executor evidence before confirmation and performs read-only global-policy preflight. For deny-default profiles it materializes every selected allow with sandbox-scoped `policy allow network` and proves every explicit allow plus the fixed `blocked.invalid:443` deny target. For the selected `open` baseline it adds no sandbox-scoped network rule, performs canonical bounded safe allow probe(s), and forbids claimed deny evidence. The contract records the policy default explicitly. The logical name remains in `sandbox.profile` but never becomes sbx `--profile`. Each separately selected policy requires its own launch-bound export and proof. Its bounded `F2ProofReportV2` is accepted only when every export binding and evaluator decision matches exactly. The live runner verifies pinned executable/evidence, successful policy preflight and create, evaluator allow decisions, and successful `rm` before report emission. It does not inspect the effective mount table, version result, port publication, real traffic, the host-Pi bridge/OAuth route, or post-cleanup zero-sandbox inventory. `policy check network --sandbox <name> <target> --json` is the proof surface; it has no `--profile`, and its denied result intentionally exits nonzero. V1 remains available solely for offline fixtures.

The script never starts/resets/authenticates the daemon, never runs `policy init`, and never constructs a generic `shell (Get-Location)` sandbox. Before use, a human must review the machine-wide effect on every sbx sandbox and run the one-time `sbx policy init allow-all`. This open baseline provides no destination-egress isolation; filesystem, mount, process, identity, and runtime-tool proof remain meaningful. This is the required workflow; it does not claim that a real live proof has been performed.

## Live evidence still required

A narrow personal-Pi/open runner invocation may have occurred, but without a retained tracked launch-bound V2 plan/report it does not close repository-verifiable acceptance. Pinned standalone `sbx` client/daemon diagnostics, real VM mounts/network/port publication, host-Pi tool/OAuth routing, live Claude OAuth enrollment for both app names, opposite-identity denial, daemon restart, authentication isolation, clone fetch/direct-provider delivery, and containment/bypass observations remain unexecuted. Offline reports therefore set `builtInClaudeEvidence` to `null`; only the opt-in live script may emit `source: live` with separate enrollment, isolation, denial, and capture-signature digests for personal and work. The Pi launch-private bridge is production code with fake-worker end-to-end evidence, and the Claude built-in VM route is proof-bound production code; neither by itself claims a live VM containment proof. Docker therefore does not become the default from this offline slice. Live sbx daemon/VM/auth attestation remains an installation gate and is not claimed here.
