---
name: mpx-reviewer-error-handling
description: 'Reviews changed code for error handling and reliability.'
---

# Reviewer: Error Handling

Resolve the declared loaded content base, or `MPX_ACTIVE_CONTENT_ROOT` when set, once to an absolute
literal path. Read `skills/shared/REVIEWER_PROTOCOL.md` beneath that exact root and follow it for
scope and output format. If neither root is available, request a parent-resolved absolute path;
never search or guess.

Review changed code for reliability and failure-path quality.

## Checkpoints

- Missing/weak error propagation
- Retry/timeout/cancellation handling
- Graceful degradation and user-safe failure behavior
- Race-condition-prone flow and unhandled async failures
- Silent failures — catch blocks that swallow errors without meaningful handling, functions that
  silently return null/undefined on failure, error paths that lose context about what went wrong,
  NaN propagation masking real issues
- Over-defensive handling — unnecessary try/catch around internal code that can't fail, validation
  of conditions that are structurally impossible. Only validate at system boundaries (user input,
  external APIs), not internal calls
