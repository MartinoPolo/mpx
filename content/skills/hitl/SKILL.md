---
name: hitl
description: Resolve human decisions blocking Issues and make confirmed work autonomous
triggers: resolving HITL Issues within an Epic or dependency graph
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: explicit-only
---

# HITL Resolution

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

## Workflow

1. Use an explicit Epic ID when supplied. Otherwise run the resolved provider reference’s documented native operation with an explicit target for open Epic candidates and ask the user to choose when ambiguous. Fetch the Epic with the resolved provider reference’s documented native operation with an explicit target.
2. List open task Issues, parse `Blocked by` relationships, and build the dependency graph. An HITL Issue is unblocked when each blocker is finished or confirmed AFK.
3. Select unblocked HITL Issues by lowest ID or descending transitive unblock count. Report cycles and fully blocked queues rather than guessing.
4. For each Issue, extract unresolved decision points, remove decisions already settled by Epic context, and explore relevant code to answer discoverable questions.
5. Present thematic question batches with evidence-backed recommendations. Use a follow-up round only when earlier answers materially affect later ones. This is the HITL gate.
6. Append `## Resolved Decisions` through the resolved provider reference’s documented native operation with an explicit target. If all decisions are resolved, replace HITL with AFK using the resolved provider reference’s documented native operation with an explicit target; otherwise retain HITL and append `## Unresolved — Needs Implementation`.
7. Ask whether to continue, recompute the graph after every update, and enqueue newly unblocked HITL Issues.
8. Report resolved, partially resolved, still blocked, and newly unblocked AFK Issues.

Preserve user privacy: include only decisions needed for implementation, never private conversation, credentials, unrelated personal context, or inferred identity data in Issue bodies.

On `CAPABILITY_UNSUPPORTED`, stop the affected update, preserve the decision transcript locally in the session, and return structured remediation plus a manual handoff. Never use direct provider tooling or claim labels changed.
