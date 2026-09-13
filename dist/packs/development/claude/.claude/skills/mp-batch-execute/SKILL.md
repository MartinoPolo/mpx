---
argument-hint: <range|list|label:<x>|board> [size:S|M|L] [--parallel] [--full-review|--no-review]
description: Execute a selected batch of small Issues on one shared branch and publish one PR
disable-model-invocation: true
metadata:
  author: MartinoPolo
  category: project-management
  version: "0.11"
name: mp-batch-execute
---

# Batch Execute

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable.

Read [REFERENCE](REFERENCE.md), [Provider Routing](../../../../../../claude/instructions/shared/PROVIDER_ROUTING.md),
and [Parent-owned Check and CI Repair](../../../../../../claude/instructions/shared/REPAIR_ORCHESTRATION.md).
Independently resolve `issues.provider` and `repository.provider` from `mpxconfig.json`; load each
selected native provider guide linked by Provider Routing. Never invent MPX facade provider actions
or change the native authentication environment.

## Rules

Default is one Issue at a time on one shared `batch/<slug>` branch in the user-selected Orca
checkout. `--parallel` requires separate checkouts created by the user in Orca; this skill does not
create, switch, remove, or orchestrate worktrees. Gate `HITL` and `design needed`. Never alter a
correct test merely to pass. Commands come from repository policy/check discovery and are propagated
exactly.

## Selection

Parse range, comma list, `label:<x>`, or `board`, plus optional size and flags. In Issue mode, use
the selected issues provider's native broad open-Issue listing, then filter client-side by requested
range/list/label. Keep `AFK`; before filtering, route `HITL` or `design needed` through the gate
unless that exact label was explicitly selected. Parse `## Blocking Relationships`/body links and
drop Issues with open blockers. Apply size last while preserving provider order.

In board-direct mode, read `.mpx/BOARD.md`; select every item under `# To Process` regardless of
checkbox and read linked files under `.mpx/board-files/`. In Issue mode board entries live under
`# Ready to implement`. Create a visible progress entry for every selected and skipped item using
the runtime task facility when available; mark each selected item in progress before its worker
starts and completed only after its commit is confirmed, while skipped items retain their recorded
reason.

## Checkout and branch

Before code inspection or editing, confirm the current checkout is the user-selected Orca checkout
for this batch and require a clean tree. Create or reuse `batch/<slug>` from the configured base in
that checkout. If the checkout is wrong or ambiguous, stop and ask the user to select or create it
in Orca; do not switch checkouts or manipulate worktrees.

## Execution

Sequentially invoke one `mpx-tdd-executor` per Issue, providing exact Issue/board text, body-linked
artifacts, acceptance criteria as REQ-1..N, target context, exact discovered check/test commands,
and exact conventional commit message with provider-appropriate Issue reference. Each executor edits
and commits only the shared batch branch; confirm its commit before advancing. If a worker exits or
returns partial work, inspect that item's edits and contract, then finish the same bounded item or
retry it; commit and mark progress complete only after all REQs pass. Never discard useful partial
work or leave a half-applied item.

With explicit `--parallel`, first require one user-created Orca checkout per Issue and an explicit
integration checkout. Run only disjoint items concurrently when the native agent runtime can bind
each worker to the correct checkout without moving this session; otherwise report parallel
orchestration as deferred and offer the normal sequential workflow. Confirm each commit and
integrate it onto the batch branch with ordinary Git. Resolve conflicts before verification. See
[REFERENCE](REFERENCE.md).

## Integrated verification

Run once on the integrated branch. Dispatch `mpx-checker` with exact static/test commands and
dispatch the default four reviewers; add security/performance/error-handling for `--full-review`;
use no reviewers for `--no-review` but still run checks/tests. E2E and assertion-based browser
verification apply to changed UI/source/config/dependency surfaces, with server-freshness/checkout
sanity first and explicit PASS/FAIL per surface. Supply all results to `mpx-check-reporter`, then
evaluate its assessment. Send accepted precise repairs to `mpx-executor` or behavioral repairs to
`mpx-tdd-executor`. Route unresolved findings to `mpx-unresolved-issue-tracker`; blockers stop
publication. Main owns at most three repair iterations, commits accepted repairs through
`mpx-git-committer`, re-dispatches affected checks/reviewers, and requires a fresh complete local
verification before publication.

## Board writeback

Move every successful item to `# Manual testing`, creating the heading if needed. Leave `- [ ]`;
only the user marks manual verification. Match Issue-mode entries by their native `issue:<id>`
annotation or body link and board-direct entries by exact text. Do not lose attached image links.

## Publish

Push only as authorized by invocation/repository policy. Use the selected repository provider's
native commands to create exactly one PR containing the commit→Issue table, parent/child body links,
provider closing references, and unresolved findings. Capture explicit PR ID and URL. Run native CI
status/watch. For a failure, validate the explicit provider run/job identity and dispatch
`mpx-ci-analyzer`; evaluate its bounded evidence and delegate accepted precise repairs to an
executor. Verify locally, commit/push only through the authorized parent workflow, and request or
await another run, for at most three attempts. Independently confirm fresh green status for the
explicit PR before completing publication. Merge only when separately requested or unambiguously
authorized by repository policy—batch execution does not require automatic merge.

Report Issue→commit mappings, skips and gate decisions, exact checks, review fixes/findings, visual
PASS/FAIL per surface, board moves, PR ID/URL, CI, merge state, and blockers.
