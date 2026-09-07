---
name: review
description: 'Reviews a branch, working diff, or provider Review across specialist axes and optionally applies fixes. Use when asked to review code, changes, or a Review.'
triggers: reviewing a branch, working changes, or provider Review; full or partial specialist coverage; optional autofix
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: full
---

# Unified Review

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

Review the intended change against its Issue and repository contracts. Run a review phase, then an optional fix phase. Prioritize actionable findings over summary.

## Parameters

- `scope=branch` reviews `<base>...HEAD`; detect the base from repository refs unless supplied.
- `scope=changes` reviews both unstaged and staged changes. Report “no changes” and stop when both are empty.
- `scope=review:<id>` reviews the provider Review returned by the resolved provider reference’s documented native operation with an explicit target.
- `full` runs all seven specialist reviewers; `partial` or `half` runs the first four. Default to `full`.
- Explicit `autofix` or `autofix=true` enables fixes; `autofix=false` disables them. When omitted, enable fixes below 10 findings and disable them at 10 or more.

If scope is missing or invalid, ask the user. Provider Reviews always require an explicit Review ID; there is no implicit Review discovery.

## Reviewer sets

Full coverage runs these canonical agents:

- `mp-reviewer-code-quality`
- `mp-reviewer-best-practices`
- `mp-reviewer-spec-alignment`
- `mp-reviewer-test-quality`
- `mp-reviewer-security`
- `mp-reviewer-performance`
- `mp-reviewer-error-handling`

Partial coverage runs the first four.

## Workflow

1. Establish the target. For local scopes use ordinary `git` commands. For a provider Review use the explicit command above.
2. When an Issue identifier is available, run the resolved provider reference’s documented native operation with an explicit target and map acceptance criteria to evidence.
3. Inspect the complete diff, relevant callers, tests, error paths, security boundaries, and compatibility impact.
4. Spawn the selected reviewers in parallel with the diff, changed files, original task or specification, stack conventions, and resolved scope. Accept high-confidence findings only. Reconcile every reviewer result exactly once.
5. Run focused repository checks when permitted. Use the resolved provider reference’s documented native operation with an explicit target for provider CI state and the resolved provider reference’s documented native operation with an explicit target only when failed-check details are needed.
6. Merge findings in Critical, Important, then Minor order. Write `REVIEW.md` only when findings exist; otherwise return a clean summary and residual verification gaps.
7. Decide autofix from the explicit parameter or finding threshold. Keep review read-only when autofix is off or there are no findings.
8. For autofix, analyze each finding into an exact file, current code, and concrete change, then spawn `mp-executor` with only those pre-analyzed instructions. Re-run the same reviewers in parallel after changes. Repeat up to three iterations or until clean, recording each post-fix result in `REVIEW.md`.
9. State which acceptance criteria are verified, unverified, or contradicted. Report findings first with precise locations and consequences; separate blockers from optional improvements.

## Unsupported capability

After any MPX Issue, Review, or CI command, if the JSON response has `ok: false` and `error.code: CAPABILITY_UNSUPPORTED`, stop that provider operation. Continue only with independent local review evidence, clearly marking the unavailable evidence. Report the unsupported capability and structured remediation. A direct provider command is not a fallback.

For every other structured provider error, report the code and actionable message and do not present the failed lookup as evidence.

## Output

```markdown
Mode: review
Scope: [branch|changes|review]
Coverage: [full|partial]
Autofix: [true|false|auto-resolved]
Findings: [critical, important, minor counts]
Report: [path or none]
Fix Step: [not requested|clean|remaining issues]
Acceptance Evidence: [verified, unverified, contradicted]
```
