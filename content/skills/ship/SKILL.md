---
name: ship
description: Deliver verified work through commit, provider-neutral Review, CI, and authorized merge
triggers: shipping or merging completed work end to end
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: name-only
---

# Ship

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

The main agent orchestrates bounded results and never bypasses Review or CI gates.

## Workflow

1. Inspect status, branch/upstream, full diff, and commits. Determine which steps are already confirmed. Preserve unrelated changes and sync the base through ordinary `git` only when authorized.
2. Run repository-prescribed checks. Delegate a focused conventional commit/push to `mp-git-committer`; retry bounded failures twice and stop if unresolved.
3. Use a trusted explicit Review ID if supplied. It remains immutable for the run: never replace it from branch or provider discovery. Inspect with the resolved provider reference’s documented native operation with an explicit target. If title, body, or target needs correction, use the resolved provider reference’s documented native operation with an explicit target.
4. Otherwise create through the resolved provider reference’s documented native operation with an explicit target, and capture the returned Review ID as the explicit immutable ID. There is no implicit Review or CI discovery.
5. Check once with the resolved provider reference’s documented native operation with an explicit target, then run the resolved provider reference’s documented native operation with an explicit target while pending. Never merge while pending or failed. If no checks are confirmed, state that absence and require policy/authority before continuing.
6. For failure details run the resolved provider reference’s documented native operation with an explicit target. Delegate diagnosis/fixes, commit and push, and use the resolved provider reference’s documented native operation with an explicit target only for an authorized justified retry. Repeat the CI fix loop at most three times, then stop blocked.
7. When checks are green and readiness requirements hold, run the resolved provider reference’s documented native operation with an explicit target. Merge only with explicit authority via the resolved provider reference’s documented native operation with an explicit target, using a method permitted by repository policy. Do not use an automatic merge as the CI gate.
8. Confirm merged state with the resolved provider reference’s documented native operation with an explicit target, post an optional summary via the resolved provider reference’s documented native operation with an explicit target, then sync the main worktree safely.
9. Report sync, commit, Review ID/URL, CI results and retry count, merge confirmation, Issue/board writeback, and remaining manual handoffs.

## Errors

For `CAPABILITY_UNSUPPORTED`, stop the affected Review/CI action, preserve confirmed git and provider results, and return structured remediation. Never invent a command outside the shipped provider reference. Other structured errors stop that gate without claiming delivery.
