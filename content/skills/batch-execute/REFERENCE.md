# Batch Execute Reference

## Shared branch default

The user-selected Orca checkout owns one shared branch. Execute and confirm one Issue commit before
starting the next. Verification and code review run once over the integrated branch.

## Explicit `--parallel`

Only an explicit user request permits parallelism. The user creates one isolated checkout per Issue
in Orca and supplies an integration checkout. Workers may edit only their assigned checkout; this
skill never creates, switches, removes, or orchestrates worktrees. If the native agent runtime cannot
bind workers to those checkouts, parallel orchestration is deferred and the sequential path remains
available. Integrate confirmed commits into the batch branch by merge or cherry-pick, resolve
conflicts before verification, and never treat per-checkout checks as a substitute for the
integrated gate.

Parallel app/DB checks need independent manually started servers and state. Prefer parallelism only
for disjoint, statically checkable work; MPX does not manage project servers or port state.

## Verification

Discover commands from repository instructions/canonical script and preserve each command exactly.
Always run static checks and unit tests. Run e2e for source, route, component, spec, config, or
dependency changes. UI surfaces require assertion-based browser verification with
server-freshness and checkout sanity checks and PASS/FAIL per surface; screenshots alone are not
evidence.

## Recovery

If a worker exits with partial edits, inspect that assigned checkout and either finish the bounded
item or retry it. A half-applied item may not be integrated. Conflicts, an exhausted three-iteration
check loop, or unresolved visual failures block PR publication.
