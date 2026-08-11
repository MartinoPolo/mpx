# Port allocation

## Authority and projections

The per-user registry at `%LOCALAPPDATA%/mpx/ports-registry.json` is the global authority for MPX port leases. A worktree's `.worktree-ports.json` is only a local projection. Consumers must distrust it until `mpx ports resolve` verifies its shape, repository/worktree identity, project, configuration hash, service map, and corresponding registry lease. `resolve` and `status` are read-only and never allocate or repair state.

The validated **full project configuration** is canonical-JSON encoded and SHA-256 hashed. A lease made for another configuration hash is not current.

## Allocation rules

Managed, checkout-scoped services are grouped into families. An explicit `family` groups its members; otherwise consecutive preferred ports form an automatic family. For a family with preferred minimum `min` and maximum `max`, its exact width is `max - min + 1`, and service port allocation is:

```
port(service, slot) = service.preferred + slot * width
```

The main worktree uses slot 0. Linked worktrees begin at slot 1 and advance the complete map together when a candidate conflicts. A managed project-scoped service reuses the project's main-worktree port. A `fixed-shared` service always uses its preferred port, is not exclusive, and emits a warning when another lease claims it.

## Concurrency and recovery

Registry updates use an interprocess lock and atomic replacement. Stale lock recovery uses lock ownership/fingerprint and age checks; clients must not delete locks manually. The registry commits before projections, so retrying `ensure` repairs a missing projection without changing an already stable lease. Ordinary `reconcile` removes leases for disappeared linked worktrees and repairs missing projections for worktrees still reported by Git.

`mpx ports reconcile --rebuild` is the explicit disaster-recovery path for a missing or corrupt registry. It scans only roots declared in user scopes plus the current project root, never follows symbolic links, and rebuilds exclusively from strict local projections, current validated project configurations, and current Git identities. Any malformed, tampered, conflicting, or orphaned candidate aborts the complete atomic rebuild; old registry-only metadata is never reused.

## Commands

- `mpx ports ensure` — allocate a stable lease when needed and repair projections.
- `mpx ports resolve` — strictly validate and read the current lease.
- `mpx ports list` — list the globally authoritative registry in stable order.
- `mpx ports inspect` — show process-safe summaries for listeners on registered ports.
- `mpx ports kill PID` or `mpx ports kill --pid PID` — terminate only the explicit PID when it is listening on an exclusive managed registry claim and has a process start fingerprint that can be rechecked natively.
- `mpx ports release` — release the current worktree lease (a main lease cannot be released while linked leases remain).
- `mpx ports reconcile` — reconcile only the current repository.
- `mpx ports reconcile --rebuild` — strictly rebuild the complete registry from known user roots and local projections.
- `mpx status` — produce a read-only status snapshot; it never ensures a lease.

Use `--json` for one versioned envelope. Allocation warnings appear in the envelope's top-level `warnings` array. `--all` is unsupported.

## Safety

Never trust a PID alone. `kill` requires the explicit PID to be listening on an exclusive managed registry claim and requires a nonempty process start fingerprint. It forwards that exact PID/fingerprint pair to the platform adapter for a native recheck immediately before termination. Project-path metadata is not required for this explicit PID action. A listener on a fixed-shared or other non-exclusive registered port is not authorized. Inspection exposes bounded process metadata rather than command lines or environment variables. A missing or relative `LOCALAPPDATA` fails with `STATE_ROOT_UNAVAILABLE` before default state access.
