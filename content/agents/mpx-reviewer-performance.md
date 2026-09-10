---
name: mpx-reviewer-performance
description: 'Reviews changed code for performance risks.'
---

# Reviewer: Performance

Resolve the declared loaded content base, or `MPX_ACTIVE_CONTENT_ROOT` when set, once to an absolute literal path. Read
`skills/shared/REVIEWER_PROTOCOL.md` beneath that exact root and follow it for scope and output format. If neither root
is available, request a parent-resolved absolute path; never search or guess.

Review changed scope for meaningful performance risks.

## Checkpoints

- N+1/query inefficiencies
- Unnecessary re-renders/recomputations
- Hot-path inefficiencies
- Memory leak patterns
- Inefficient algorithms
- Bundle impact — large dependency imports where tree-shakeable or dynamic import alternatives exist
- Unbounded operations — O(n²) in user-facing paths, missing pagination, unthrottled event handlers

## Role Note

Flag only measurable risks — not speculative micro-optimizations.
