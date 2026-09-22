---
name: execute
description: Execute one Issue or inline work with implementation, testing, review, and verified delivery
argument-hint: "[issue|inline/checklist] [--no-tdd|--full-review|--no-auto-merge]"
metadata:
  author: MartinoPolo
  version: "2.10"
  category: project-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: normal
---

# Execute Work

Own requirements analysis, acceptance, repair decisions, and the final report. Delegate
implementation, checks, simplification, review, and delivery. Keep the agreed scope and delivery
endpoint as the objective. Ask only about missing prerequisites or material ambiguity.

## Delegation

Give each agent **task context**: its objective, relevant requirements and constraints, file or diff
pointers, and useful findings already established. Read its input contract and supply what the task
needs. Carry applicable flags, authorization, and remaining time into every dispatch, including repairs. Evaluate their actual changes and evidence before accepting results.

Set phase budgets before dispatch: default to 5 minutes for discovery/diagnosis, 10 for focused
checks, 30 for the complete gate, and 15 for visual acceptance. Adjust to project needs before
starting. Enforce timeouts through supported tool controls; do not reset elapsed budgets on retry.

## 1. Resolve

- Issue reference: fetch its title, body, labels, comments, state, and URL. Extract the goal,
  constraints, acceptance criteria, and blockers.
- Inline text: parse tasks or checklist items. Do not write back to an Issue.

Before provider operations, follow [Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md)
for the roles the operation needs. Local inline work needs no provider setup.

Use the current checkout. Read repository instructions, branch, and status; preserve unrelated work.
Ask if a checkout mismatch or overlapping changes prevents safe execution. Do not manage worktrees.
While awaiting input, continue independent authorized work and retain background task handles.
Collect their results before resuming dependent work.

If the Issue has `HITL` or `design needed`, ask whether to abort, run HITL grilling, or finish design.
Establish the delivery endpoint before implementation:

- Inline work: local `commit`, without push or PR.
- Work repository Issue: `pr`, stopping at green CI with the PR/MR open.
- Personal repository Issue: `merge`, requiring confirmed merge.
- `--no-auto-merge`: use `pr` for Issue work.

Invocation authorizes that endpoint. Resolve personal/work ownership from account/domain context,
not the Git host; ask if unclear.

## 2. Analyze

Read requirements yourself. Use direct reads for known targets and `mpx-explorer` for broad discovery.
Define scope, acceptance criteria, risks, and verification needs.

Read linked designs before planning. Match intended layout, map colors to semantic/theme tokens,
and reuse existing components and variants. Carry these design constraints into task context;
mockups do not override project conventions.

## 3. Implement and simplify

Dispatch `mpx-executor` for the agreed scope. Inspect its diff and verification evidence.
Dispatch `mpx-simplifier` once if there is a concrete simplification opportunity; otherwise skip it.
Carry the selected test mode into both assignments. Retain material choices and uncertainty for
reporting, not routine coding decisions.

## 4. Verify and review

Use focused checks during implementation, not the complete gate.

When checks need a live application, follow [server discovery and lifecycle](DEV_SERVER.md).
Main owns the server and supplies the verified URL to agents.

Finish formatting before review. Do not overlap writers or checks that share mutable resources.
Use fresh `mpx-executor` sessions for accepted repairs. Retry affected checks during diagnosis;
after repairs, refresh affected reviews and visual evidence, then rerun the complete gate.
Allow at most three local repair/review iterations. Diagnose product defects, environment conflicts,
and shutdown hangs before retrying; require new evidence for an unchanged failing batch.
Stop and report unresolved failures when the budget is exhausted.

### 4a. Deterministic checks

Ask `mpx-checker` to run `fast_checks`. Evaluate the results and formatting changes.

### 4b. Visual acceptance

For changes to appearance or visible interaction, dispatch `mpx-visual-verifier` with task context
and the prepared browser prerequisites. Evaluate its findings. Do not skip visual acceptance because
E2E tests passed or `--no-tdd` was selected.

### 4c. Code review

Dispatch independent reviewers in parallel:

- `mpx-reviewer-code-quality`
- `mpx-reviewer-best-practices`
- `mpx-reviewer-spec-alignment`
- `mpx-reviewer-test-quality`

For `--full-review`, add `mpx-reviewer-security`, `mpx-reviewer-performance`, and
`mpx-reviewer-error-handling`. Identify the intended diff, including its baseline, in task context.
Reconcile contradictory findings before authorizing repairs.

### 4d. Final gate

Use `mpx-checker` to complete `fast_checks` and `full_checks`.
Require passing results for the final source and check environment. Reuse completed checks only
while those inputs remain unchanged. Missing checks, timeouts, and absent successful process exits
block delivery; reporting them does not make them passes.

## 5. Deliver

Recheck acceptance and the selected endpoint. Prepare a substantive change summary, then dispatch
`mpx-shipper` with task context, explicit intended paths, summary, and verification evidence.
Supply its required delivery identities and authorization; preserve completed-stage evidence on retry.

Allow three shipping attempts total. Evaluate failures, delegate accepted repairs to a fresh
executor, and verify again before retrying. Give CI repairs the validated repository, PR, branch,
commit, and failing run/job identities. A confirmed CI-only infrastructure failure may retry that
job within the shipping budget without repeating unchanged local checks. Other input changes
invalidate the local gate.

## 7. Report

Return a summary message, not a report file. Start with the actual outcome, then cover:

- acceptance, delivery evidence, and verification results;
- material choices and uncertainty;
- unresolved issues, blockers, and workflow problems.

Link the Issue and PR when applicable. Include representative final screenshots when visual
acceptance ran. Put each link on its own line.
Suggest durable decisions for `DECISIONS.md`; write them only after user approval.

## Flags

- `--no-tdd`: do not create tests during implementation; existing checks still run.
- `--full-review`: add the specialist reviewers listed above.
- `--no-auto-merge`: stop at green CI with the PR/MR open.
