---
name: epic-decompose
description: Decompose an Epic into approved vertical-slice Issues with capability-aware linking
triggers: breaking an Epic into implementation Issues
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: explicit-only
---

# Decompose an Epic

Use the canonical [Issue template](ISSUE_TEMPLATE.md).

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Fetch the explicit Epic and comments using `mpx issue view --identity <launch-identity> --json`; stop if absent or empty. Comments override stale body decisions only when their authority is clear.
2. Resolve Epic-wide ambiguity at a HITL gate. Explore the codebase rather than asking discoverable questions. A slice-specific decision cluster may remain as a clearly stated HITL Issue.
3. Design 3–15 independently testable vertical slices. Each maps Epic requirements to observable acceptance criteria, labels exactly one of HITL/AFK, and records blocking relationships. Put unanswered questions only in HITL bodies.
4. Present titles, classifications, requirement coverage, labels, and dependency graph. Create nothing before explicit approval.
5. Ensure labels via `mpx tool invoke --capability issue.labels.ensure --identity <launch-identity> --json`. Build every body from [ISSUE_TEMPLATE.md](ISSUE_TEMPLATE.md), then call `mpx issue create --identity <launch-identity> --json` and capture each immutable Issue ID.
6. Link and update only through launch-bound capabilities. For a provider-neutral relationship use `mpx tool invoke --capability issue.sub-issue --identity <launch-identity> --json`; for blocking writeback use `mpx issue edit --identity <launch-identity> --json`.
7. Report all created IDs/URLs and the final dependency graph. Never claim links that were not confirmed.

## Provider capability branches

- When the launch provider is GitHub, request native `issue.sub-issue` and `issue.template` capabilities. Preserve GitHub sub-issues and templates when supported.
- When the provider is GitLab, use native Issue creation but request those same capabilities. On `CAPABILITY_UNSUPPORTED`, return structured remediation; never emulate a native sub-issue with an unconfirmed textual link.
- For any unsupported provider or tool capability, preserve confirmed Issues, stop the affected operation, and report `CAPABILITY_UNSUPPORTED` plus structured remediation. Do not fall back to direct provider commands.

A failed optional link does not erase successfully created Issues, but support status and manual handoff must be explicit.
