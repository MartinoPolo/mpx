# Execute: Mergeability, CI, and Close-out

Follow [Parent-owned Check and CI Repair](../../../../../pi/instructions/shared/REPAIR_ORCHESTRATION.md).

Read [Provider Routing](../../../../../pi/instructions/shared/PROVIDER_ROUTING.md), independently resolve `repository.provider`,
and use only that provider's native PR and CI commands from its guide. `<review-id>`, `<branch>`,
and `<base>` remain explicit immutable values.

## Mergeability

Query PR mergeability. If conflicting, invoke `mpx-executor` with this bounded git task:

> Merge the selected provider remote's `<base>` into `<branch>` and resolve all conflicts. Prefer
> feature work for code written for the current Issue while incorporating compatible base-only
> changes. Fetch the configured remote's base before merging. Run the exact static/test commands
> supplied below. Return only the executor contract with resolved conflicts, verification evidence,
> and any blockers. Do not commit or push.

Pass check commands exactly as discovered. On `Completed`, invoke `mpx-git-committer` with
`push: true` and the conflict resolution summary, then re-query mergeability. Retry at most twice;
on an executor/committer blocker or exhausted retries, report the bounded summary and blockers to
the user and stop before CI/finalization.

## CI green gate

Use the repository provider guide to watch all PR checks. Local checks are not a substitute. If
checks fail, obtain the explicit native run/pipeline and job identity, validate it against
`<review-id>` and `<branch>`, and dispatch `mpx-ci-analyzer` with those immutable identities and the
exact discovered local commands. Evaluate its bounded evidence and suggestions; send each accepted
precise repair to `mpx-executor` or behavioral repair to `mpx-tdd-executor`. Run the exact local
verification, commit and push only through the authorized parent workflow, then request a new native
CI run or wait for the provider-triggered run. Repeat at most three times. Route unresolved findings
through triage and blockers to the user; the analyzer never repairs, reruns, commits, pushes, or
confirms completion.

After any repair, independently query fresh native status for the explicit PR and latest
identity-bound run. Before finalization confirm: every commit is remote, every applicable check
passed, the PR remains mergeable, and the current checkout is clean. If no checks exist, report that fact
and proceed only when repository policy permits.

## Finalization

1. Compose a normal professional report: Issue/task, tests, changed files from agent contracts, PR
   URL, CI URL/status, retries, unresolved triage, review summary, and blockers.
2. Post byte-identical report as a native PR comment where supported.
3. Unless `--no-auto-merge`, apply repository merge policy; otherwise prefer squash, then merge,
   then rebase among allowed methods (or the provider's configured submit strategy). Invocation
   authorizes this without confirmation. Merge only after the explicit green gate and poll until
   native PR state is merged. Report policy/approval blockers; never bypass them or use automatic
   merge as the CI gate.
4. After confirmed merge, delete the remote branch when policy permits. Report the main-branch
   synchronization command the user can run in the appropriate Orca checkout; do not switch the
   current checkout or create, remove, or update another worktree.
5. Output the same report and include exact provider/PR state.

Continue only when every applicable gate passes. With `--no-auto-merge`, green CI plus posted report
is successful close-out; otherwise a confirmed merged PR is required.
