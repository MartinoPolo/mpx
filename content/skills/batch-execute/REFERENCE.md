# Batch Execute Reference

## Shared branch default

The dedicated batch worktree owns one shared branch. Execute and confirm one Issue commit before starting the next.
Verification and code review run once over the integrated branch.

## Explicit `--parallel`

Only an explicit user request permits parallelism. Create one real isolated git worktree per Issue. Workers edit and
commit only their assigned worktree; the orchestrator integrates confirmed commits into the batch branch by merge or
cherry-pick. Resolve conflicts before verification. Never treat per-worktree checks as a substitute for the integrated
gate.

Per-worktree app/DB checks need independent servers and state. Prefer parallelism only for disjoint, statically
checkable work. Remove only worktrees created by this run; never alter a user's existing worktree.

## Verification

Discover commands from repository instructions/canonical script and preserve each command exactly. Always run static
checks and unit tests. Run e2e for source, route, component, spec, config, or dependency changes. UI surfaces require
assertion-based browser verification with stale-server/worktree sanity checks and PASS/FAIL per surface; screenshots
alone are not evidence.

## Recovery

If a worker exits with partial edits, inspect that assigned worktree and either finish the bounded item or retry it. A
half-applied item may not be integrated. Conflicts, an exhausted three-iteration check loop, or unresolved visual
failures block PR publication.
