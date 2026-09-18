---
name: harvest-decisions
description:
  'Explicitly harvests authorized recent session decisions into project context and decision
  documents...'
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

Harvest design and architecture decisions only when the user explicitly invokes this skill. Use the
current native conversation plus any user-identified, explicitly approved native session transcripts
or excerpts, deduplicate the decisions, preview proposed documentation changes, and write only after
confirmation.

## 1. Bind scope and date

1. Bind the project root to the current user-selected checkout. Do not inspect other worktrees,
   infer identity from remotes, or enumerate account/session storage.
2. Parse the invocation input as a non-negative number of days back; use 30 when absent. It filters
   dated source material but never authorizes discovery. Ask for a corrected value when invalid.
3. Include the current native conversation content available to this session. For older material,
   accept only native session IDs or transcript paths the user explicitly supplies and authorizes
   for this project. Read those sources directly and read-only; do not guess native storage layout,
   walk session directories, or use an MPX session registry/recorder.
4. Verify each supplied source belongs to the selected project from its visible metadata or ask the
   user to confirm it. Apply the date filter to available timestamps. A mismatch stops only that
   source without broadening scope.

## 2. Handle unavailable session access safely

If an identified native transcript cannot be read safely, offer a privacy-safe manual fallback. Ask
the user to provide or paste excerpts containing the relevant question, answer, date, and optional
rationale. Keep temporary excerpts only in native conversation context or a user-approved scratch
file, minimize quoted content, and discard the file after extraction. Never disclose private storage
locations, enumerate unrelated sessions, request secrets, or tell the user to weaken authorization.

If the user declines the fallback, continue with independently available authorized sources; when
none remain, report that no authorized content was available and make no documentation changes.

## 3. Find and extract decision discussions

Use a named `mpx-explorer` child to locate candidate interaction events within the authorized current conversation, explicitly supplied transcripts, or excerpts. Do not
ask it to discover or search native transcript storage.

Use actual decision interaction events as the primary signal: explicit `grill`, `hitl`, or
`architecture-review` invocations paired with design or architecture questions and the user's
answer. Historical projected invocation names such as `{{MPX_SKILL_PREFIX}}grill`,
`{{MPX_SKILL_PREFIX}}hitl`, and `{{MPX_SKILL_PREFIX}}architecture-review` remain valid. Mentions in available-command lists, prose references to a
skill name, implementation logs, and tool output are not decisions.

If that signal yields fewer than five candidate sessions, use the runtime's normalized
question-and-answer events as a secondary signal, looking for structured option questions about
design or architecture. Never treat an unanswered question as a settled choice.

For a small result set, extract directly. For several sessions, launch parallel read-only children
in bounded groups of roughly three or four sessions. Use canonical `standard` documentation agents
that declare their own model class; if only a generic agent is available, select the `standard`
class through structured runtime configuration. Pass only authorized source identifiers or normalized excerpts, never private storage details. Ask each child to return one markdown item per settled
decision with:

- **Topic** and the question;
- **Answer** from the user;
- **Rationale**, when stated;
- **Decision date** from runtime metadata;
- **Category**: Platform, UI-Design, Data-State, Session-Providers, Workflow, or Domain-Language;
  and
- **Authorized source ID** for traceable deduplication.

Skip open questions, tool-call details, code output, and implementation-only material.

## 4. Compare project documentation

Read `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` under the authorized project root when present. Treat
any project memory supplied through an authorized runtime or by the user as comparison input only;
never discover account memory directly.

If a destination file is absent, include creation in the preview rather than creating it
immediately. A new `CONTEXT.md` should contain concise Domain Language, Core Features, Key
Constraints, and Flagged Ambiguities sections. A new `DECISIONS.md` should group entries by domain.

## 5. Deduplicate and resolve conflicts

1. Group findings by domain and topic.
2. Deduplicate equivalent decisions, retaining the most complete rationale and authorized
   references.
3. Mark decisions already represented in either destination document.
4. Identify differing answers to the same topic as conflicts.

For every conflict, show both dated alternatives and their stated rationale. Ask the user which
decision stands. Do not infer a winner. Keep unresolved conflicts out of settled decision entries
and list them as unresolved in the preview.

## 6. Preview and confirm

Prepare a preview before any write. It must show:

- source counts: current, user-supplied, authorized, date-filtered, and containing decisions;
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

Ask for explicit confirmation of the preview. A request to revise returns to the preview; a
rejection or absent confirmation ends without writes.

## 7. Write confirmed changes

Only after confirmation, apply exactly the confirmed preview beneath the authorized project root.
Preserve existing content and avoid duplicating documented decisions. Add confirmed domain terms to
`CONTEXT.md`; add settled decision entries to `DECISIONS.md`. Never delete memory files during
harvesting.

Report:

- sources available, authorized, scanned, and containing decisions;
- access denials and whether privacy-safe manual excerpts were supplied;
- decisions extracted, deduplicated, new, and already documented;
- conflicts resolved or left open;
- `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` files created or updated; and
- authorized memory files suggested for cleanup.

Do not quote sensitive source text in the report.
