# Workspaces

MPX exposes worktree, port, and configured development-service behavior through one application-owned workspace facade.
The underlying `@mpx/worktrees`, `@mpx/ports`, and `@mpx/dev-services` packages remain independent domain modules.

```text
mpx workspace list
mpx workspace show [path] [--machine]
mpx workspace create <branch> [--base <ref>] [preparation approval options]
mpx workspace remove <path>
mpx workspace start <service-id> [path]
mpx workspace stop <service-id> [path]
mpx workspace logs <service-id> [path] [--lines <1..500>]
mpx port kill <pid>
```

`workspace show` without a path selects the Git worktree containing `--cwd`. Machine mode prints only its canonical
path, which makes it suitable for shell `cd` wrappers.

Normal operations perform one bounded recovery pass. If that pass reports a structurally valid, bounded orphan set and
its generated exact approval, the application performs at most one second reconcile with that approval; it never loops.
Read operations report bounded, redacted degraded diagnostics when recovery cannot complete. Mutations fail before their
first side effect when recovery is blocked, except `stop`, which first attempts tolerant recovery and remains
risk-reducing. `logs` also makes one tolerant recovery attempt while preserving errors from the log operation. Removal
stops managed checkout-scoped services before durable Git removal and identity-bound lease release.

Every versioned workspace result includes a stable `kind`: `workspace-list`, `workspace-show`, `workspace-mutation`,
`workspace-service`, `workspace-service-logs`, or `port-killed`.

Only package-script services declared in `mpxconfig.json` are managed. External and test-only services are shown but
cannot be started, stopped, or queried for logs through MPX. The CLI never accepts an executable, argument vector, or
environment value for a service.

Logs are limited to 500 requested lines and 20,000 characters. `port kill` delegates verified listener termination to
`@mpx/ports`; it does not provide a generic process-kill path.
