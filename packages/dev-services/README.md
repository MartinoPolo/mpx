# @mpx/dev-services

Provider-neutral managed development-service lifecycle support.

Host processes are started as a validated executable plus argument vector without a command shell. Ownership is bound to the exact root PID and OS start fingerprint; stop targets the owned process tree only. Readiness failures become durable crashed diagnostics, and terminal-safe log reads are bounded.

The CLI uses private state below `%LOCALAPPDATA%/mpx/dev-services`, keyed by canonical checkout root. This allows status, logs, restart, and stop to reconcile a service started by an earlier CLI process. Missing and fingerprint-mismatched processes are recorded as crashed and are never terminated.

## Docker runtime

`DockerRuntimeAdapter` binds `dev_server` to an immutable launch key, exact VM worktree, assigned ports, `RemoteToolClient`, and a named `SandboxRuntimeHandle`. Spawn, VM readiness, loopback-published host readiness, inspection, bounded logs, restart, and process-group stop cross that handle. Port conflicts and foreign fingerprints fail closed; no Docker operation constructs a host runtime or invokes a host kill.

Runtime projection assembly must select this adapter for Docker and forward `dev-services:changed` events. Live `sbx` acceptance remains gated by the Phase F2 proof; there is no host fallback.

## Process model

Services are foreground programs owned through their spawned process tree. Package scripts that daemonize, re-parent, or otherwise escape that tree are unsupported.
