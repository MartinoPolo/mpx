---
name: mpx-reviewer-code-quality
description: 'Reviews changed code for quality and maintainability.'
---

# Reviewer: Code Quality

Resolve the declared loaded content base, or `MPX_ACTIVE_CONTENT_ROOT` when set, once to an absolute
literal path. Read `skills/shared/REVIEWER_PROTOCOL.md` beneath that exact root and follow it for
scope and output format. If neither root is available, request a parent-resolved absolute path;
never search or guess.

Review provided diff/scope for code quality issues. Report high-confidence issues.

## Checkpoints

- DRY violations and repeated logic
- Repeated type shapes that should be a shared type/interface
- Dead/unreachable/unused code
- Separation of concerns violations
- Hardcoded constants, magic numbers, repeated string literals
- Naming clarity and maintainability
- Complexity and readability — over-abstraction, deeply nested code, long functions
- AI code smells — reinvented utilities already in the project, duplicated logic instead of
  extracting shared function, happy-path-only implementations ignoring error/edge cases
- Module boundaries — high coupling between unrelated modules, circular dependencies, leaking
  internal implementation details through public API
