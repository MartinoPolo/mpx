---
name: batch-execute
description: Execute an approved batch of small Issues with isolated progress and one Review
triggers: implementing a range, list, label selection, or board batch
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: explicit-only
---

# Batch Execute

Orchestrate a bounded batch. Default to one worker at a time on one shared branch; isolated worktrees may run concurrently only when explicitly requested. See [REFERENCE.md](REFERENCE.md).

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Resolve the explicit Issue range/list or label with `mpx issue list --identity <launch-identity> --json`, or read `# To Process` from `.mpx/BOARD.md`. Filter by requested size and open blocking relationships.
2. **HITL gate:** if an Issue has `HITL` or `design needed` and the selection did not explicitly request that label, ask whether to skip, include, or complete design first. Record skipped and blocked items.
3. Require a clean tree, create `batch/<slug>`, and create visible progress entries. Preserve unrelated work.
4. Execute one Issue per `mp-executor`, sequential by default. Give each worker exact acceptance criteria, target context, checks, and commit message. Confirm each commit before starting the next. Never change a test merely to pass it.
5. Run repository-prescribed static checks and tests once over the integrated branch. Fix failures at most three times, then stop as a hard blocker.
6. Unless review is disabled, run the canonical `review` skill over the complete batch. Apply its review loop up to three iterations, commit accepted fixes, then rerun checks. For changed UI, run assertion-based visual checks per surface; unresolved failures block publication.
7. Move successful board items to `# Manual testing`, retaining `- [ ]` because only the user records manual verification. This board writeback applies to Issue and board-direct modes.
8. Push only with authorization. Create exactly one Review using `mpx review create --title <title> --body <body> --source-branch <source> --target-branch <target> --identity <launch-identity> --json`. Capture its explicit Review ID and URL; do not rediscover it.
9. Report Issue-to-commit mappings, skips, checks, review findings, visual results, board moves, and Review ID.

## Errors

For `CAPABILITY_UNSUPPORTED`, stop only the affected provider step, preserve local results, and return the structured remediation. Never fall back to a provider CLI. Other structured failures are reported without claiming success.
