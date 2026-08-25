# @mpx/dev-services

Provider-neutral managed development-service domain for host or executor-specific runtime adapters.

The package owns lifecycle state, bounded terminal-safe logs, all-port readiness, immutable PID fingerprints, reconciliation, process-tree stop, and `dev-services:changed` events. `createDevServerToolAdapter` exposes the launch-bound `dev_server` contract without depending on Claude or Pi packages.

## Remaining runtime wiring

Runtime index files are intentionally untouched. During immutable Pi projection assembly, the runtime-specific extension must create an executor-matching `RuntimeAdapter`, construct `DevServiceManager`, bind `createDevServerToolAdapter` with the launch key, selected executor, exact worktree root, and assigned ports, register the returned contract as `dev_server`, forward `dev-services:changed` to Pi events, and call `shutdown()` on session shutdown. A Docker launch must supply a Docker runtime adapter; `createSystemRuntime()` identifies itself as host and is rejected.

## Windows

The host adapter starts a foreground command via hidden `cmd.exe /d /s /c` and uses `taskkill.exe /PID <pid> /T /F` only after exact in-memory fingerprint verification. Commands that daemonize or escape the spawned tree are unsupported. The current CLI adapter is process-scoped: cross-invocation durable supervision and recovery after the owning CLI process exits require the installation/runtime supervisor wiring above.
