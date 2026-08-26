# Phase F2 host-Pi / sandbox-executor split

Phase F2 production routing is implemented without performing a real container or authentication operation.

## Host/private boundary

For Docker launches, Pi's process, TUI, model connection, OAuth store, session and history stay on the host. `ExecutionService` launches that process only through its dedicated host-Pi process adapter. Account roots and `PI_CODING_AGENT_DIR` are therefore never sent to the selected Docker executor.

Before session start, `activatePiSandboxExecutor` atomically replaces the complete model-triggerable tool set. It reasserts the same exact set at `session_start` and before every agent turn. File operations, shell/process, Git, browser, MCP, web/content, development services, skill search/load and all child-agent operations are remote proxies. A Docker launch without replacement support, a launch-bound remote executor, or complete attestation fails closed; there is no native host fallback. Host execution remains a separate explicitly approved compatibility mode.

## Binding and privacy

`ProductionRemoteExecutorRegistry` binds a `SandboxHandle` to launch key, identity, plan, capability and the Phase F1 inventory digest. Requests are sequenced and hash-bound. Cross-identity use, stale/replaced handles, replay, result mismatch, inventory widening and child authority widening are denied. Child lifecycle requests retain the same Docker executor and parent binding through `ChildLaunchAuthorityV1` and can only narrow tools/resources/routes/mounts/destinations/skills/models and nesting.

Remote serialization rejects OAuth/authorization/token fields and values, account/native-root fields, `PI_CODING_AGENT_DIR`, `auth.json`, bearer values and token-shaped canaries. Sandbox plans expose only generated sandbox state and include negative VM-scan booleans. Native roots, credentials, opposite-domain roots, Docker sockets and Git common directories are protected mount boundaries.

## Inventory and evidence

[`inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json`](inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json) is generated from the code-owned registry and now records all 53 top-level and child paths. Its `runtimeToolInventorySha256` binds remote tool-set attestation; its executor evidence digest binds proof to the implementation. Any registry or executor change invalidates prior evidence.

The fake sandbox worker integration proves envelopes and routing without a real container or auth. Live sbx daemon/VM/auth attestation remains an installation gate and is not claimed here.
