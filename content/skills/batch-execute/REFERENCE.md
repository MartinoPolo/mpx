# Batch Execute Reference

## Concurrency

Sequential execution on the dedicated batch worktree's shared branch is the safe default. Experimental parallel execution requires an additional real isolated worktree per Issue. Workers may edit and commit only their assigned worktree; the orchestrator integrates each confirmed commit into the batch worktree and resolves conflicts before verification. Run the verify and review gates once on the integrated batch branch, never separately as a substitute.

Use the runtime's worktree operation for the batch worktree. Use ordinary `git worktree`, merge, and cherry-pick operations for explicitly requested per-Issue parallelism. Clean up only worktrees created by this run and do not alter a user's existing worktree.

## Verification

Derive commands from repository instructions. Always run static checks and unit tests; include end-to-end and visual verification when changed surfaces require them. Visual checks must assert observable state, avoid stale servers, and report PASS/FAIL per surface rather than relying on screenshots alone.

## Recovery

If a worker exits with partial edits, inspect its state and either complete the bounded item or retry it. Never continue with a half-applied item. A conflict, exhausted check loop, or unresolved visual failure is a hard blocker to Review creation.
