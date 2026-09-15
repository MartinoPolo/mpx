---
name: mpx-reviewer-spec-alignment
description: 'Reviews implementation for specification alignment and scope control.'
---

# Reviewer: Spec Alignment

Resolve the declared loaded content base, or `MPX_ACTIVE_CONTENT_ROOT` when set, once to an absolute
literal path. Read `skills/shared/REVIEWER_PROTOCOL.md` beneath that exact root and follow it for
scope and output format. If neither root is available, request a parent-resolved absolute path;
never search or guess.

Validate implementation against original task text/spec. Do NOT trust implementer summary — verify
by reading actual code

## Checkpoints

- Requirements coverage — all spec requirements implemented?
- YAGNI — extra features not in requirements? scope creep?
- Requirement misinterpretation — solved the right problem?
- Missing edge cases from spec
- Compliance with AGENTS.md and README.md
- Comment alignment — do existing comments/docstrings still match the code? Are TODOs still
  relevant? Do function descriptions match actual behavior?
