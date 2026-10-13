---
name: hitl
description: Resolve human decisions blocking Issues and make confirmed work autonomous
argument-hint: '[epic or issue reference] [lowest|most-blocking]'
metadata:
  author: MartinoPolo
  version: '0.6'
  category: project-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# HITL to AFK

Read [Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md) and independently resolve `issues.provider`
and `repository.provider` from `mpxconfig.json`; this workflow uses the selected issues provider's
native guide in `{{MPX_SHARED_INSTRUCTIONS}}/providers/`. Never invent facade actions. Parent/child relationships are
body links, not assumed provider-native sub-Issues. Preserve the native authenticated environment, explicit provider target, and privacy.

Parameters: optional Epic or Issue reference and ordering `lowest` (default) or `most-blocking`.
An Issue is HITL when it carries `HITL` or a `### HITL (unanswered questions)` section.

1. If a non-Epic Issue is supplied, fetch it natively and continue at step 5 with that Issue alone.
   If an Epic is supplied, fetch it natively. Otherwise list open Epic-labeled Issues; ask when
   ambiguous and stop if none. Read its body, especially implementation decisions.
2. Broadly list open task Issues with labels and bodies. Parse the Blocking relationships section and
   parent/child body links into a graph. Fetch blocker states as needed.
3. An HITL Issue is eligible when every blocker is closed/finished or labeled `AFK`. Distinguish no
   HITL, all resolved, all blocked, and dependency cycles; report instead of guessing.
4. Sort eligible Issues by ascending provider ID for `lowest`, or descending transitive unblock
   count for `most-blocking`, and present a useful queue, for example `1. issue:3 — Dashboard CRUD`
   or `1. issue:3 — Dashboard CRUD (unblocks 6 downstream)`.
5. For each Issue, extract ambiguities from the HITL section, description, and acceptance criteria;
   remove decisions already settled by Epic context. Before asking questions, invoke named agent
   `mpx-explorer` to inspect relevant code and report evidence. If external library facts are
   uncertain, route to Context7.
6. Present thematic batches of numbered questions with evidence-backed recommendations. Ask a
   follow-up round only when prior answers materially affect it.
7. Delete each answered question from the HITL section and put its answer where it belongs in the
   body, usually the description or acceptance criteria. When no question remains, remove the
   section and replace `HITL` with `AFK` using native provider commands; where the provider has
   no `HITL` label, add `AFK`. Otherwise keep the remaining questions and `HITL`. Preserve the rest
   of the body and its links exactly.
8. Ask whether to continue. Recompute the graph after every update and enqueue newly unblocked HITL
   Issues.
9. Report concrete outcomes by category, for example `Resolved/AFK: issue:3 — Dashboard CRUD`,
   `Partial/HITL: issue:7 — 2 experiments remain`, `Blocked: issue:9 by issue:6`, and
   `Newly unblocked AFK: issue:4`. Include cycles when found.

Record only implementation decisions—never private conversation, credentials, personal context, or
inferred identity. If a selected provider lacks an operation, preserve the exact proposed body/label
change as a manual handoff and do not claim it succeeded.
