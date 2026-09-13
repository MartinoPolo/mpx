---
name: ship
description: Ship finished work through sync, commit, native PR, CI, and merge
argument-hint: '[base-branch] [--no-auto-merge]'
metadata:
  author: MartinoPolo
  version: '0.7'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Ship

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable.

Parent-owned orchestration: specialists return bounded evidence while this skill evaluates repairs,
controls retries, and confirms final status. Follow
[Parent-owned Check and CI Repair]({{MPX_SHARED_INSTRUCTIONS}}/REPAIR_ORCHESTRATION.md), then read
[Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md), independently resolve `issues.provider` and
`repository.provider` from `mpxconfig.json`, and read both selected guides linked by Provider
Routing. Issue lookup/writeback uses the Issue provider; PR and CI use the repository provider. Use
documented native commands only, never invented MPX facade actions. Keep explicit Issue, PR, run,
and branch identities immutable and preserve the native authentication environment.

## State-based entry

Inspect before acting and enter at the first incomplete state:

| Confirmed state                        | Entry                             |
| -------------------------------------- | --------------------------------- |
| Uncommitted changes                    | sync/check, then commit and push  |
| Commits not on the selected remote     | push                              |
| Pushed branch, no PR                   | find Issue, then publish PR       |
| Explicit open PR, CI pending or failed | watch or repair CI                |
| Explicit PR with green CI              | authorized merge                  |
| PR already merged                      | post-merge synchronization/report |

## Flow

1. Inspect status, branch/upstream, full diff, and local/remote commits. Accept a supplied PR ID as
   immutable; otherwise use native repository commands to detect an existing PR once, capture its
   explicit ID/URL, and retain that identity for the run. Skip only steps proven complete. Preserve
   unrelated changes.
2. Resolve base deterministically from argument/repository policy and sync it with ordinary git
   before committing when safe. Conflicts are delegated to a bounded executor with exact check
   commands; stop on unresolved conflict.
3. Invoke `mpx-git-committer` with `push: true` and a diff-derived commit hint. Route `OK`; on
   `SKIP`, independently determine whether push is needed; on `FAIL`, provide the concrete error to
   a bounded fixer and retry at most twice.
4. If no PR exists, invoke named agent `mpx-issue-finder` with repository identity, branch, commits,
   and diff summary. Route `high` to publication; present bounded `candidates` for selection; on
   `none`, continue without an Issue only after reporting the reason. Then invoke named agent
   `mpx-review-manager` with the selected Issue ID when any, base branch, and diff-derived
   description. Route `OK` only when it returns an explicit PR ID/URL; route `FAIL` to a bounded
   fix/retry (maximum two), then stop. If a PR already exists, invoke `mpx-review-manager` for any
   required title/body/target update and require its returned PR identity to match the captured one;
   a mismatch blocks the run. Retain that explicit identity for every CI, comment, and merge
   operation.
5. Query mergeability. If conflicting, merge the remote base into the branch, resolve with feature
   intent plus compatible base changes, run exact repository checks, commit/push through
   `mpx-git-committer`, and re-query. Maximum two conflict iterations.
6. Watch native CI to completion. Never merge while pending or failed. If no checks exist, report
   this and proceed only when repository policy allows.
7. On failure, validate the native run/pipeline and job identity against the immutable repository,
   PR, and branch, then dispatch `mpx-ci-analyzer` with those identities and the exact local
   verification commands. Evaluate its evidence and suggestions. Send accepted precise repairs to
   `mpx-executor`, or behavioral repairs to `mpx-tdd-executor`; verify locally, commit/push through
   the authorized parent workflow, and request or await the next native run. Re-analyze at most
   three failing runs. Route unresolved findings through `mpx-unresolved-issue-tracker`; route
   blockers to the user and stop. The analyzer does not edit, rerun, commit, push, or watch CI.

8. After an independent fresh native status query confirms every applicable check green for the
   explicit PR identity, detect permitted merge strategies and prefer squash, then merge, then
   rebase. Merge explicitly; automatic merge must never substitute for the green gate.
   `--no-auto-merge` stops after green with PR open.
9. Confirm native PR state is merged. Compose a professional final report with sync, commit, PR
   ID/URL, CI URL/status and attempts, merge confirmation, Issue/board writeback, changed
   files/tests, unresolved triage, and manual handoffs. Post byte-identical text as a PR comment
   where supported.
10. After confirmed merge, delete the remote feature branch when allowed. Report the ordinary Git
    command for synchronizing the main branch in its Orca checkout. Do not switch the current
    checkout or create, remove, or update another worktree.

A provider capability gap becomes a structured manual handoff with preserved completed local work;
never fall back to another provider or claim success. Without `--no-auto-merge`, completion requires
confirmed merge, not merely local checks or green CI.
