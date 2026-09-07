# Ports

`%LOCALAPPDATA%/mpx/ports-registry.json` is the per-user authority for leases. `.worktree-ports.json` is a verified checkout projection, never an independent source of truth.

Managed services are grouped into explicit or automatically detected consecutive families. For family width `max - min + 1`:

```text
port(service, slot) = service.preferred + slot * width
```

The main checkout uses slot zero. Linked worktrees advance the complete service map together when a candidate conflicts. Project-scoped services reuse the main checkout port. `fixed-shared` services always use their preferred port, are non-exclusive, and warn on another claim.

Registry changes use an interprocess lock and atomic replacement. Recovery trusts only current project configuration, Git worktree identity, and strict local projections. Malformed, tampered, conflicting, or orphaned state blocks mutation.

Use `mpx workspace list|show` to inspect assignments. `mpx port kill <pid>` terminates only an explicit PID that currently owns an exclusive managed listener and still matches its process start fingerprint. It is not a generic process-kill command.

Never delete lock or registry files manually. A missing or relative `LOCALAPPDATA` fails closed.
