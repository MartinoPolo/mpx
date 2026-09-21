---
name: review
description:
  'Reviews a branch, working diff, or provider PR across specialist axes and optionally applies...'
argument-hint:
  'scope=<branch|changes|review[:id|#id|url]> [full|partial|half]
  [autofix|autofix=true|autofix=false]'
triggers:
  reviewing a branch, working changes, or provider PR; full or partial specialist coverage; optional
  autofix
metadata:
  author: MartinoPolo
  version: '0.8'
  category: code-review
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: normal
---

# Unified Review

Review the intended change against its Issue and repository contracts, then optionally fix findings.
Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable.
`the invocation input`

Before a provider command, read [Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md), resolve
`repository.provider`, and use its native guide. Preserve the native CLI authentication environment.
Status/login diagnostics may inspect the active account, but do not log in or out, substitute
credentials, or switch accounts.

## Parameters

- `scope=branch` reviews `<base>...HEAD`. Use an explicit base hint when supplied; otherwise resolve
  [the bundled base detector](scripts/detect-base-branch.js) and run it from its
  resolved skill-relative path.
- `scope=changes` reviews `git diff` plus `git diff --cached`; stop with “no changes” when both are
  empty.
- `scope=review` or `scope=review:<id|#id|url>` reviews a provider PR. The `review` selector is an
  internal compatibility name. Use the explicit reference when given; otherwise resolve the current
  branch artifact with the selected native guide. Fetch metadata and the complete diff; drafts are
  valid.
- `full` runs all seven reviewers; `partial` or `half` runs the first four. Default: `full`.
- Explicit `autofix` enables fixes and `autofix=false` disables them. When omitted, fixes are on
  below 10 findings and off at 10 or more.

Ask the user when scope is missing or invalid.

## Reviewer sets

Full coverage runs:

- `mpx-reviewer-code-quality`
- `mpx-reviewer-best-practices`
- `mpx-reviewer-spec-alignment`
- `mpx-reviewer-test-quality`
- `mpx-reviewer-security`
- `mpx-reviewer-performance`
- `mpx-reviewer-error-handling`

Partial coverage runs the first four.

## Workflow

1. Resolve the scope and collect the complete diff and changed files. When an Issue is available,
   fetch it and map each acceptance criterion to evidence.
2. Inspect relevant callers, tests, error paths, security boundaries, compatibility impact, and
   repository contracts—not only changed lines.
3. Spawn the selected reviewers in parallel with the diff, files, task or specification, acceptance
   criteria, conventions, and scope. Reviewers must run in sessions distinct from the author/executor;
   request fresh review of changed scope when the reviewed diff changes. Accept high-confidence
   findings only and reconcile each result once.
4. When useful and permitted, run focused repository checks. Existing CI state may be used as
   evidence; fetch failed-check details only when needed. Do not require CI watching, polling, or
   review loops.
5. Merge findings in Critical, Important, then Minor order. Write `REVIEW.md` only when findings
   exist; otherwise return a clean summary and residual verification gaps.
6. Decide autofix from the explicit flag or threshold. Keep review read-only when fixes are off or
   no findings exist.
7. For autofix, analyze each finding into an exact file, current code, and concrete change. Discover
   bounded checks from project `fast_checks` / `full_checks` or repository scripts. For every
   accepted repair, spawn `mpx-executor` with relevant requirements, failures, acceptance criteria,
   the precise repair objective, and file pointers; instruct it to inspect the current `git diff`
   and relevant files itself. Then dispatch `mpx-checker` and await formatting and early checks
   before running the same reviewers and deferred checks in parallel, up to three iterations or
   until clean. Reviewers do not write source. Append post-fix results to `REVIEW.md`.
8. State which acceptance criteria are verified, unverified, or contradicted. Report findings first
   with precise locations and consequences; separate blockers from optional improvements.

## Behavior contract

- Source edits occur only in the fix phase through `mpx-executor`.
- Do not commit or publish provider comments or PRs.
- A failed provider lookup is not evidence. Report its exact structured failure and continue only
  with independent local evidence when possible; never switch identities or providers.

## Output

```markdown
Mode: review Scope: [branch|changes|review] Coverage: [full|partial] Autofix:
[true|false|auto-resolved] Findings: [critical, important, minor counts] Report: [path or none] Fix
Step: [not requested|clean|remaining issues] Acceptance Evidence: [verified, unverified,
contradicted] Verification Gaps: [none or concise list]
```
