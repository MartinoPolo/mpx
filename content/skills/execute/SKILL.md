---
name: execute
description: Implement one approved Issue with test-first verification, review, and close-out gates
triggers: implementing an approved Issue
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: full
---

# Execute an Issue

Read [tests](tests.md), [mocking](mocking.md), and [close-out](CLOSE_OUT.md) when those phases begin.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Resolve the explicit Issue with `mpx issue view --identity <launch-identity> --json`. Read repository instructions and restate requirements and acceptance criteria. Stop at the HITL gate for unresolved product decisions.
2. Inspect relevant code, callers, tests, branch status, and current repository policy. Preserve unrelated changes and privacy-sensitive data.
3. Plan the smallest coherent implementation. Delegate independent items concurrently only when file ownership is disjoint; otherwise execute sequentially. Every worker receives exact requirements, files, checks, and role boundaries.
4. Follow red-green-refactor per observable behavior: add one focused test, prove its expected failure, implement the minimum, then refactor while green. Do not change a valid test merely to pass.
5. Run focused checks after each behavior, then repository-prescribed static checks, unit tests, and relevant integration/e2e tests. Fix failures at most three iterations; unresolved failures block close-out.
6. Run the canonical specialist review over the complete diff. Apply accepted findings through a bounded review loop, up to three iterations, and rerun checks. UI changes also require assertion-based visual verification per affected surface.
7. Inspect the final diff and status. Follow [close-out](CLOSE_OUT.md): update durable docs when warranted, collect acceptance evidence, and require manual handoffs where automation cannot verify.
8. If authorized, write status with `mpx issue comment --identity <launch-identity> --json`, lane with `mpx issue move --identity <launch-identity> --json`, and completion with `mpx issue finish --identity <launch-identity> --json`. Never finish before acceptance evidence and Review/CI obligations are satisfied.
9. Report changed files, tests and checks, review results, acceptance mapping, Issue state, risks, and manual actions.

## Capability errors

For `CAPABILITY_UNSUPPORTED`, stop the affected provider operation, preserve completed local work, and report structured remediation. Never fall back to direct provider tooling. Other errors are reported without claiming the update succeeded.
