# Workspaces

MPX exposes worktree, port, and configured development-service behavior through one
application-owned workspace facade. The underlying `@mpx/worktrees`, `@mpx/ports`, and
`@mpx/dev-services` packages remain independent domain modules.

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

`workspace show` without a path selects the Git worktree containing `--cwd`. Machine mode prints
only its canonical path, which makes it suitable for shell `cd` wrappers.

Pi's main-session worktree handoff snapshots Git's worktree inventory before asking the workspace
Hub to create a checkout. A create request without an explicit base reuses the current canonical
checkout when it already has the requested branch; an explicit base is never silently ignored.
Entering the checkout that is already Pi's canonical working directory continues the task in the
current session without forking or switching.

A native Pi session can fork its history and switch to another validated worktree root. An
MPX-managed Pi launch cannot safely rebind its launch-fixed context, projection, skills, and
lifecycle resources in place. For a managed cross-root request, MPX prepares and preserves the
destination but refuses the session fork before switching or sending the task; start a fresh managed
Pi launch in that destination. The source session remains active. Any managed launch marker, even a
partial or malformed one, fails closed rather than falling back to native behavior.

On Windows the handoff invokes the authenticated MPX Node entry directly because shell-free child
processes do not resolve the installed `mpx.cmd` selector. If the Hub fails after Git has created
the requested branch checkout, the handoff validates and enters only that newly reported worktree
and surfaces the bounded Hub diagnostic as a warning. This is a narrow safe recovery: it never
treats a pre-existing checkout as the result of the failed request or converts an unknown failure
into permission to run the task in the old directory. When no new checkout exists, the error leaves
the current session usable and gives a manual Git plus `/worktree --enter` recovery path.

Normal operations perform one bounded recovery pass. If that pass reports a structurally valid,
bounded orphan set and its generated exact approval, the application performs at most one second
reconcile with that approval; it never loops. Read operations report bounded, redacted degraded
diagnostics when recovery cannot complete. Mutations fail before their first side effect when
recovery is blocked, except `stop`, which first attempts tolerant recovery and remains
risk-reducing. `logs` also makes one tolerant recovery attempt while preserving errors from the log
operation. Removal stops managed checkout-scoped services before durable Git removal and
identity-bound lease release.

Every versioned workspace result includes a stable `kind`: `workspace-list`, `workspace-show`,
`workspace-mutation`, `workspace-service`, `workspace-service-logs`, or `port-killed`.

Only package-script services declared in `mpxconfig.json` are managed. External and test-only
services are shown but cannot be started, stopped, or queried for logs through MPX. The CLI never
accepts an executable, argument vector, or environment value for a service.

Logs are limited to 500 requested lines and 20,000 characters. `port kill` delegates verified
listener termination to `@mpx/ports`; it does not provide a generic process-kill path.
