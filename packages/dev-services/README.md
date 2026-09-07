# @mpx/dev-services

Provider-neutral managed development-service lifecycle support.

Host processes are started as a validated executable plus argument vector without a command shell. Ownership is bound to
the exact root PID and OS start fingerprint; stop targets the owned process tree only. Readiness failures become durable
crashed diagnostics, and terminal-safe log reads are bounded.

The CLI uses private state below `%LOCALAPPDATA%/mpx/dev-services`, keyed by canonical checkout root. This allows
status, logs, restart, and stop to reconcile a service started by an earlier CLI process. Missing and
fingerprint-mismatched processes are recorded as crashed and are never terminated.

## Docker runtime

Optional whole-agent sandbox integration is pending. Production launch and resume requests selecting Docker fail closed
with `EXECUTOR_UNAVAILABLE` before service or process execution and never fall back to host. Existing read-only sandbox
diagnostics are retained for future integration but do not authorize execution.

## Process model

Services are foreground programs owned through their spawned process tree. Package scripts that daemonize, re-parent, or
otherwise escape that tree are unsupported.
