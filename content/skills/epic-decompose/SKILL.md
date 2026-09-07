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

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

Use the canonical [Issue template](ISSUE_TEMPLATE.md).

## Workflow

1. Fetch the explicit Epic and comments using the resolved provider reference’s documented native operation with an explicit target; stop if absent or empty. Comments override stale body decisions only when their authority is clear.
2. Resolve Epic-wide ambiguity at a HITL gate. Explore the codebase rather than asking discoverable questions. A slice-specific decision cluster may remain as a clearly stated HITL Issue.
3. Design 3–15 independently testable vertical slices. Each maps Epic requirements to observable acceptance criteria, labels exactly one of HITL/AFK, and records blocking relationships. Put unanswered questions only in HITL bodies.
4. Present titles, classifications, requirement coverage, labels, and dependency graph. Create nothing before explicit approval.
5. Ensure labels via the resolved provider reference’s documented native operation with an explicit target. Build every body from [ISSUE_TEMPLATE.md](ISSUE_TEMPLATE.md), then call the resolved provider reference’s documented native operation with an explicit target and capture each immutable Issue ID.
6. Link and update only through provider-resolved capabilities. For a provider-neutral relationship use the resolved provider reference’s documented native operation with an explicit target; for blocking writeback use the resolved provider reference’s documented native operation with an explicit target.
7. Report all created IDs/URLs and the final dependency graph. Never claim links that were not confirmed.

## Provider capability branches

- When the launch provider is GitHub, request native `issue.sub-issue` and `issue.template` capabilities. Preserve GitHub sub-issues and templates when supported.
- When the provider is GitLab, use native Issue creation but request those same capabilities. On `CAPABILITY_UNSUPPORTED`, return structured remediation; never emulate a native sub-issue with an unconfirmed textual link.
- For any unsupported provider or tool capability, preserve confirmed Issues, stop the affected operation, and report `CAPABILITY_UNSUPPORTED` plus structured remediation. Do not fall back to direct provider commands.

A failed optional link does not erase successfully created Issues, but support status and manual handoff must be explicit.
