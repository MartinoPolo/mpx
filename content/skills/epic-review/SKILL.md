---
name: epic-review
description: Review a completed Epic across code, architecture, cleanup, documentation, and unresolved work
triggers: end-of-Epic review and optional accepted fixes
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: explicit-only
---

# Epic Review

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Fetch the explicit Epic and its children/comments using `mpx issue view --identity <launch-identity> --json` and `mpx issue list --identity <launch-identity> --json`. Warn on open children but continue because invocation is explicit.
2. Collect only Reviews linked by confirmed Issue/Review data. For each explicit Review ID run `mpx review view --id <review-id> --identity <launch-identity> --json`. An explicit Review ID is immutable: never replace it from branch or provider discovery.
3. Compute the aggregate local diff from the earliest confirmed Epic commit. Build bounded context slices; exclude credentials, private unrelated comments, and unnecessary personal data.
4. Run ten analysis branches concurrently: six canonical specialists plus architecture, cleanup, documentation, and unresolved-work branches from [analysis branches](ANALYSIS_BRANCHES.md). Require an explicit result from all ten.
5. Deduplicate and classify Critical/Important/Minor findings across code quality, architecture, decomposition, cleanup, documentation, and unresolved work. Write `.mpx/reviews/PHASE_END_EPIC_<id>.md` using [the template](PHASE_END_TEMPLATE.md); reconcile every count and disposition.
6. **HITL gate:** show the full action list and wait for confirmation, edits, drops, or deferral. Never execute automatically.
7. After approval follow [execution and close-out](EXECUTION.md). Use bounded `mp-executor` groups, rerun checks, and update each checkbox.
8. Close the Epic only after accepted findings and children are resolved or explicitly deferred and the user confirms closure.

If Issue, Review, CI, or tool capabilities return `CAPABILITY_UNSUPPORTED`, preserve local review evidence, mark unavailable evidence, and report structured remediation plus manual handoff. Never fall back to provider CLIs.
