# Ports

`%LOCALAPPDATA%/mpx/ports-registry.json` is the per-user authority for leases. `.worktree-ports.json` is a verified checkout projection, never an independent source of truth.

## Ordinary development servers

Managed reservations are not a prerequisite for ordinary dev-server or Storybook startup. Discover commands in
`package.json` and referenced configuration; when MPX port metadata is absent, use project defaults. If a port is
occupied, choose an alternative only when the server and dependent URLs can be configured reliably; otherwise ask
before stopping the existing server. Do not silently reuse another checkout's server.

In Pi, use `dev_server` for foreground server ownership and cleanup. Its `ports` field checks readiness; configure the
application's listening port through its command or configuration and verify the actual URL and checkout. On Windows,
`dev_server` commands run through `cmd.exe`, not Bash; use compatible quoting when invoking PowerShell.

This fallback does not fabricate a lease or bypass validation in `mpx workspace start`. Existing managed assignments
still require verification; malformed or stale metadata is not an absent-file fallback. Never hand-write a projection
to make a managed operation pass.

## Managed allocation

Managed services are grouped into explicit or automatically detected consecutive families. For family width `max - min + 1`:

```text
port(service, slot) = service.preferred + slot * width
```

The main checkout uses slot zero. Linked worktrees advance the complete service map together when a candidate conflicts. Project-scoped services reuse the main checkout port. `fixed-shared` services always use their preferred port, are non-exclusive, and warn on another claim.

Registry changes use an interprocess lock and atomic replacement. Recovery trusts only current project configuration, Git worktree identity, and strict local projections. Malformed, tampered, conflicting, or orphaned state blocks mutation.

Use `mpx workspace list|show` to inspect assignments. `mpx port kill <pid>` terminates only an explicit PID that currently owns an exclusive managed listener and still matches its process start fingerprint. It is not a generic process-kill command.

Never delete lock or registry files manually. A missing or relative `LOCALAPPDATA` fails closed.
