# @mpx/dev-services

Provider-neutral managed development-service lifecycle support.

Host processes are started as a validated executable plus argument vector without a command shell. Ownership is bound to the exact root PID and OS start fingerprint; stop targets the owned process tree only. Readiness failures become durable crashed diagnostics, and terminal-safe log reads are bounded.

The CLI uses private state below `%LOCALAPPDATA%/mpx/dev-services`, keyed by canonical checkout root. This allows status, logs, restart, and stop to reconcile a service started by an earlier CLI process. Missing and fingerprint-mismatched processes are recorded as crashed and are never terminated.

## Remaining runtime wiring

Runtime projection assembly must inject an executor-matching adapter when exposing `dev_server`. Docker remains unavailable until a Docker `RuntimeAdapter` is supplied; Docker selection never constructs or falls back to the host adapter. Runtime wiring must forward `dev-services:changed` events and bind the immutable launch key, exact worktree root, and assigned ports.

## Process model

Services are foreground programs owned through their spawned process tree. Package scripts that daemonize, re-parent, or otherwise escape that tree are unsupported.
