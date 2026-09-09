---
name: harvest-decisions
description: 'Explicitly harvests authorized recent session decisions into project context and decision documents...'
metadata:
  author: MartinoPolo
  version: '1.5'
  category: planning
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Harvest Decisions

Harvest design and architecture decisions only when the user explicitly invokes this skill. Read authorized session
content through runtime contracts, deduplicate the decisions, preview proposed documentation changes, and write only
after confirmation.

## 1. Bind scope and date

1. Read the immutable launch identity and the launch-authorized repository or worktree root from the runtime context.
   Never infer an identity or root from the current directory, account files, or repository remotes.
2. Parse the invocation input as a non-negative number of days back; use 30 when it is absent. Ask for a corrected value
   when it is invalid.
3. Use the runtime's launch-bound session discovery contract to request sessions for exactly that launch identity and
   authorized root. Include linked worktree sessions only when discovery returns them as authorized members of that same
   project scope.
4. Verify every returned session's identity and canonical root authorization before requesting its content. Apply the
   date filter to runtime-provided session timestamps before extraction.

**Identity or root mismatch:** stop and report the mismatch without reading transcript content. Do not broaden
discovery, substitute another identity, or search account storage directly.

Discovery results and session content are opaque runtime records. Do not assume a native filename, directory layout,
serialization format, role schema, or location on disk.

## 2. Handle unavailable session access safely

Request normalized, read-only content only for the authorized, date-filtered session IDs. If discovery or content access
is unsupported, unavailable, or denied, do not bypass the runtime contract.

**Access denied:** offer a privacy-safe manual fallback. Ask the user to provide or paste user-supplied excerpts
containing the relevant question, answer, date, and optional rationale. Keep temporary excerpts in the runtime's session
scratch area, minimize quoted content, and discard it after extraction. Never disclose private storage locations,
enumerate unrelated sessions, request secrets, or tell the user to weaken authorization.

If the user declines the manual fallback, report that no authorized content was available and make no documentation
changes.

## 3. Find and extract decision discussions

Use a named `mpx-explorer` child at medium breadth to locate candidate interaction events within the authorized
normalized records. Do not ask it to search native transcript storage.

Use actual decision interaction events as the primary signal: explicit `grill`, `hitl`, or `architecture-review`
invocations paired with design or architecture questions and the user's answer. Historical normalized invocation names
such as `mp-grill`, `mp-hitl`, and `mp-architecture-review` remain valid. Mentions in available-command lists, prose
references to a skill name, implementation logs, and tool output are not decisions.

If that signal yields fewer than five candidate sessions, use the runtime's normalized question-and-answer events as a
secondary signal, looking for structured option questions about design or architecture. Never treat an unanswered
question as a settled choice.

For a small result set, extract directly. For several sessions, launch parallel read-only children in bounded groups of
roughly three or four sessions. Use canonical `standard` documentation agents that declare their own model class; if
only a generic agent is available, select the `standard` class through structured runtime configuration. Pass only
authorized session IDs or normalized excerpts, never private storage details. Ask each child to return one markdown item
per settled decision with:

- **Topic** and the question;
- **Answer** from the user;
- **Rationale**, when stated;
- **Decision date** from runtime metadata;
- **Category**: Platform, UI-Design, Data-State, Session-Providers, Workflow, or Domain-Language; and
- **Authorized session ID** for traceable deduplication.

Skip open questions, tool-call details, code output, and implementation-only material.

## 4. Compare project documentation

Read `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` under the authorized project root when present. Treat any project memory
supplied through an authorized runtime or by the user as comparison input only; never discover account memory directly.

If a destination file is absent, include creation in the preview rather than creating it immediately. A new `CONTEXT.md`
should contain concise Domain Language, Core Features, Key Constraints, and Flagged Ambiguities sections. A new
`DECISIONS.md` should group entries by domain.

## 5. Deduplicate and resolve conflicts

1. Group findings by domain and topic.
2. Deduplicate equivalent decisions, retaining the most complete rationale and authorized references.
3. Mark decisions already represented in either destination document.
4. Identify differing answers to the same topic as conflicts.

For every conflict, show both dated alternatives and their stated rationale. Ask the user which decision stands. Do not
infer a winner. Keep unresolved conflicts out of settled decision entries and list them as unresolved in the preview.

## 6. Preview and confirm

Prepare a preview before any write. It must show:

- session counts: discovered, authorized, date-filtered, and containing decisions;
- extracted, duplicate, already-documented, new, and conflicting decision counts;
- the exact proposed additions or updates to `.mpx/CONTEXT.md`;
- each proposed `.mpx/DECISIONS.md` entry;
- files that would be created; and
- any authorized project memory that may now be redundant, as suggestions only.

Use this decision format:

```markdown
### Title

Decided: date What: settled choice Why: stated rationale Rejected: alternatives, when known
```

Ask for explicit confirmation of the preview. A request to revise returns to the preview; a rejection or absent
confirmation ends without writes.

## 7. Write confirmed changes

Only after confirmation, apply exactly the confirmed preview beneath the authorized project root. Preserve existing
content and avoid duplicating documented decisions. Add confirmed domain terms to `CONTEXT.md`; add settled decision
entries to `DECISIONS.md`. Never delete memory files during harvesting.

Report:

- sessions discovered, authorized, scanned, and containing decisions;
- access denials and whether privacy-safe manual excerpts were supplied;
- decisions extracted, deduplicated, new, and already documented;
- conflicts resolved or left open;
- `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` files created or updated; and
- authorized memory files suggested for cleanup.

Do not quote sensitive source text in the report.
