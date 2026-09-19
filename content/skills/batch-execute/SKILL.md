---
name: batch-execute
description: Execute a selected batch of small Issues on one shared branch and publish one PR
argument-hint: '<range|list|label:<x>|board> [size:S|M|L] [--parallel] [--no-tdd] [--full-review|--no-review]'
metadata:
  author: MartinoPolo
  version: '0.11'
  category: project-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Batch Execute

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable.

Read [REFERENCE](REFERENCE.md) and [Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md).
Independently resolve `issues.provider` and `repository.provider` from `mpxconfig.json`; load each
selected native provider guide linked by Provider Routing. Never invent MPX facade provider actions
or change the native authentication environment.

## Rules

Default is one Issue at a time on one shared `batch/<slug>` branch in the user-selected
checkout. `--parallel` requires separate checkouts created by the user; this skill does not
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

Before code inspection or editing, confirm the current checkout is the user-selected checkout
for this batch and require a clean tree. Create or reuse `batch/<slug>` from the configured base in
that checkout. If the checkout is wrong or ambiguous, stop and ask the user to select or create it
before continuing; do not switch checkouts or manipulate worktrees.

## Execution

Sequentially invoke one fresh `mpx-executor` per Issue, providing the exact Issue/board text,
body-linked artifacts and file pointers, relevant requirements, known failures, acceptance criteria
as REQ-1..N, a precise implementation objective, target context, exact discovered check/test
commands, and selected test mode. Pass the selected test mode to every fresh `mpx-executor`,
including all implementation and CI repairs. `--no-tdd` excludes creating tests during
implementation; existing verification still runs.
Instruct each executor to inspect the current `git diff` and relevant files itself. Each executor
edits only the shared batch branch. After all REQs pass, invoke `mpx-shipper` with the explicit
`commit` endpoint for that item's intended paths, confirm its commit, and only then advance or mark
progress complete. Bound per-item commit failures to three shipper attempts per item; these attempts
do not consume the separate final publication budget. If a worker exits or returns partial work,
inspect that item's edits and contract, then finish the same bounded item with a fresh executor.
Never discard useful partial work, retry an item without bound, or leave a half-applied item.

With explicit `--parallel`, first require one user-created checkout per Issue and an explicit
integration checkout. Run only disjoint items concurrently when the native agent runtime can bind
each worker to the correct checkout without moving this session; otherwise report parallel
orchestration as deferred and offer the normal sequential workflow. Confirm each commit and
integrate it onto the batch branch with ordinary Git. Resolve conflicts before verification. See
[REFERENCE](REFERENCE.md).

## Integrated verification

Run once on the integrated branch. Dispatch `mpx-checker` with exact static/test commands and let
its permitted formatting edits finish before dispatching the default four reviewers and deferred
checks in parallel; add security/performance/error-handling for `--full-review`; use no reviewers
for `--no-review` but still run checks/tests. Design reasonable, proportional test coverage from the
requirements, important failure modes, and known regressions; prefer existing coverage and add or
update tests only when they meaningfully verify changed behavior. E2E and assertion-based browser
verification apply to changed user-facing surfaces, with server-freshness/checkout sanity first and
explicit PASS/FAIL per surface. Main evaluates checker and reviewer results, distinguishes root causes from symptoms, and resolves contradictory advice before authorizing repairs. Preserve uncertainty and missing evidence rather than guessing.
Send every accepted repair to a fresh `mpx-executor` with the selected test mode, relevant
requirements, failures, acceptance criteria, a precise repair objective, and file pointers;
instruct it to inspect the current `git diff` and relevant files itself. Route unresolved findings to
`mpx-unresolved-issue-tracker`; blockers stop publication. Re-dispatch affected checks/reviewers and
require a fresh complete local verification before publication.

## Board writeback

Move every successful item to `# Manual testing`, creating the heading if needed. Leave `- [ ]`;
only the user marks manual verification. Match Issue-mode entries by their native `issue:<id>`
annotation or body link and board-direct entries by exact text. Do not lose attached image links.

## Publish

Invoke `mpx-shipper` with the explicit `pr` endpoint and the selected repository provider target.
It stages and commits intended paths, pushes as authorized, creates or updates exactly one draft PR
using the shipper's title/body contract, canonical Issue links, and provider closing references
only where valid. It monitors native CI and returns explicit PR and run identities. For a
failure, main validates those identities, evaluates the evidence, and delegates every accepted
repair to a fresh executor with the repair inputs required above. Verify
locally, then invoke the shipper again so it reconciles completed stages. Final publication has its
own three shipping attempts total—the initial attempt plus two repair/retry attempts—covering its
commit, push, PR, and CI stages without resetting during continuation. Per-item commit attempts do
not reduce this budget. Independently confirm fresh green status for the
explicit PR before completing publication. The `pr` endpoint remains unmerged.
For CI repairs, supply the validated repository, PR, branch, commit, and failing run/job identities.

Report Issue→commit mappings, skips and gate decisions, exact checks, review fixes/findings, visual
PASS/FAIL per surface, board moves, PR ID/URL, CI, merge state, and blockers.
