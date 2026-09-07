# Port allocation

## Authority and projections

The per-user registry at `%LOCALAPPDATA%/mpx/ports-registry.json` is the global authority for MPX port leases. A
worktree's `.worktree-ports.json` is only a local projection. The workspace application verifies its shape,
repository/worktree identity, project, configuration hash, service map, and corresponding registry lease before use.
`mpx workspace list` and `mpx workspace show` expose the supported read surface.

The validated **full project configuration** is canonical-JSON encoded and SHA-256 hashed. A lease made for another
configuration hash is not current.

## Allocation rules

Managed, checkout-scoped services are grouped into families. An explicit `family` groups its members; otherwise
consecutive preferred ports form an automatic family. For a family with preferred minimum `min` and maximum `max`, its
exact width is `max - min + 1`, and service port allocation is:

```
port(service, slot) = service.preferred + slot * width
```

The main worktree uses slot 0. Linked worktrees begin at slot 1 and advance the complete map together when a candidate
conflicts. A managed project-scoped service reuses the project's main-worktree port. A `fixed-shared` service always
uses its preferred port, is not exclusive, and emits a warning when another lease claims it.

## Concurrency and recovery

Registry updates use an interprocess lock and atomic replacement. Stale lock recovery uses lock ownership/fingerprint
and age checks; clients must not delete locks manually. The registry commits before projections, so retrying `ensure`
repairs a missing projection without changing an already stable lease. Ordinary `reconcile` removes leases for
disappeared linked worktrees and repairs missing projections for worktrees still reported by Git.

Workspace operations perform bounded repository reconciliation through the application facade. Recovery scans only
trusted repository inventory and rebuilds exclusively from strict local projections, current validated project
configurations, and current Git identities. Malformed, tampered, conflicting, or orphaned state blocks mutations.

## Commands

- `mpx workspace list` — list repository worktrees and their assigned ports.
- `mpx workspace show [PATH]` — show one exact worktree, configured services, listeners, and diagnostics.
- `mpx workspace start SERVICE [PATH]` — start a configured managed service in the selected executor.
- `mpx workspace stop SERVICE [PATH]` — stop a configured managed service; repeated stops are safe.
- `mpx workspace logs SERVICE [PATH]` — read bounded service logs; a never-started service returns empty text.
- `mpx port kill PID` — terminate only the explicit PID after managed-claim and process-identity verification.

The removed `status`, `worktree`, `dev`, and `ports` top-level routes are not supported.

Use `--json` for one versioned envelope. Allocation warnings appear in the envelope's top-level `warnings` array.
`--all` is unsupported.

## Safety

Never trust a PID alone. `kill` requires the explicit PID to be listening on an exclusive managed registry claim and
requires a nonempty process start fingerprint. It forwards that exact PID/fingerprint pair to the platform adapter for a
native recheck immediately before termination. Project-path metadata is not required for this explicit PID action. A
listener on a fixed-shared or other non-exclusive registered port is not authorized. Inspection exposes bounded process
metadata rather than command lines or environment variables. A missing or relative `LOCALAPPDATA` fails with
`STATE_ROOT_UNAVAILABLE` before default state access.
