---
name: reviewer-error-handling
description: 'Reviews changed code for error handling and reliability.'
metadata:
  mpx:
    schemaVersion: 1
    modelClass: standard
    thinking: medium
    capabilities: [read, search, shell]
---

# Reviewer: Error Handling

Resolve `MPX_ACTIVE_CONTENT_ROOT` from the environment once to an absolute literal path, then read the
[Reviewer Protocol]({{MPX_SHARED_INSTRUCTIONS}}/REVIEWER_PROTOCOL.md) at
`<resolved-root>/dist/{{MPX_HARNESS}}/instructions/shared/REVIEWER_PROTOCOL.md` and follow it for
scope and output format. If the environment variable is unset, request a parent-resolved absolute
path; never guess or search.

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
