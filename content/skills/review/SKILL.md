---
name: review
description: Review a change for correctness, risk, and acceptance evidence
triggers: reviewing a branch or provider Review
metadata:
  mpx:
    skillPacks: [core]
    defaultExposure: full
---
# Review a Change

Review the intended change against its Issue and repository contracts. Prioritize actionable findings over summary.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Establish the review target. Use `mpx review view --identity <launch-identity> --json` when a provider Review is identified; otherwise inspect the local branch with ordinary `git` commands.
2. When an Issue identifier is available, run `mpx issue view --identity <launch-identity> --json` and map acceptance criteria to evidence.
3. Inspect the complete diff, relevant callers, tests, error paths, security boundaries, and compatibility impact. Do not modify implementation while acting only as reviewer.
4. Run focused repository checks when permitted. Use `mpx ci status --identity <launch-identity> --json` for provider CI state and `mpx ci logs --identity <launch-identity> --json` only when failed check details are needed.
5. Report findings first, ordered by severity, with precise file locations and consequences. Separate blockers from optional improvements.
6. State which acceptance criteria are verified, unverified, or contradicted. If there are no findings, say so and identify residual verification gaps.

## Unsupported capability

After any MPX Issue, Review, or CI command, if the JSON response has `ok: false` and `error.code: CAPABILITY_UNSUPPORTED`, stop that provider operation. Continue only with independent local review evidence, clearly marking the unavailable evidence. Report the unsupported capability and any structured remediation. Do not invoke or suggest a direct provider command as a fallback.

For every other structured provider error, report the code and actionable message and do not present the failed lookup as evidence.
