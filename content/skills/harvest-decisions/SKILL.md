---
name: harvest-decisions
description: "Explicitly harvests authorized recent session decisions into project context and decision documents after user confirmation."
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: explicit-only
---
# Harvest Decisions

Harvest design and architecture decisions only when the user explicitly invokes this skill. Read authorized session content through runtime contracts, deduplicate the decisions, preview proposed documentation changes, and write only after confirmation.

## 1. Bind scope and date

1. Read the immutable launch identity and the launch-authorized repository or worktree root from the runtime context. Never infer an identity or root from the current directory, account files, or repository remotes.
2. Parse the invocation input as a non-negative number of days back; use 30 when it is absent. Ask for a corrected value when it is invalid.
3. Use the runtime's launch-bound session discovery contract to request sessions for exactly that launch identity and authorized root. Include linked worktree sessions only when discovery returns them as authorized members of that same project scope.
4. Verify every returned session's identity and canonical root authorization before requesting its content. Apply the date filter to runtime-provided session timestamps before extraction.

**Identity or root mismatch:** stop and report the mismatch without reading transcript content. Do not broaden discovery, substitute another identity, or search account storage directly.

Discovery results and session content are opaque runtime records. Do not assume a native filename, directory layout, serialization format, role schema, or location on disk.

## 2. Handle unavailable session access safely

Request normalized, read-only content only for the authorized, date-filtered session IDs. If discovery or content access is unsupported, unavailable, or denied, do not bypass the runtime contract.

**Access denied:** offer a privacy-safe manual fallback. Ask the user to provide or paste user-supplied excerpts containing the relevant question, answer, date, and optional rationale. Keep temporary excerpts in the runtime's session scratch area, minimize quoted content, and discard it after extraction. Never disclose private storage locations, enumerate unrelated sessions, request secrets, or tell the user to weaken authorization.

If the user declines the manual fallback, report that no authorized content was available and make no documentation changes.

## 3. Find and extract decision discussions

Use actual decision interaction events returned by the session contract as the primary signal: design or architecture questions paired with the user's answer. Use the runtime's normalized question-and-answer events as a secondary signal when explicit skill invocation metadata is absent. Mentions of a skill name, available-command lists, implementation logs, and tool output are not decisions.

For a small result set, extract directly. For several sessions, use the runtime Agent contract to launch parallel read-only children in bounded groups. Pass only authorized session IDs or normalized excerpts; do not pass private storage details. Each child returns, for every settled decision:

- topic and question;
- user's answer;
- rationale, when stated;
- decision date from runtime metadata;
- category: Platform, UI-Design, Data-State, Session-Providers, Workflow, or Domain-Language;
- authorized session ID for traceable deduplication.

Skip open questions and implementation-only material.

## 4. Compare project documentation

Read `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` under the authorized project root when present. Treat any project memory supplied through an authorized runtime or by the user as comparison input only; never discover account memory directly.

If a destination file is absent, include creation in the preview rather than creating it immediately. A new `CONTEXT.md` should contain concise Domain Language, Core Features, Key Constraints, and Flagged Ambiguities sections. A new `DECISIONS.md` should group entries by domain.

## 5. Deduplicate and resolve conflicts

1. Group findings by domain and topic.
2. Deduplicate equivalent decisions, retaining the most complete rationale and authorized references.
3. Mark decisions already represented in either destination document.
4. Identify differing answers to the same topic as conflicts.

For every conflict, show both dated alternatives and their stated rationale. Ask the user which decision stands. Do not infer a winner. Keep unresolved conflicts out of settled decision entries and list them as unresolved in the preview.

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
Decided: date
What: settled choice
Why: stated rationale
Rejected: alternatives, when known
```

Ask for explicit confirmation of the preview. A request to revise returns to the preview; a rejection or absent confirmation ends without writes.

## 7. Write confirmed changes

Only after confirmation, apply exactly the confirmed preview beneath the authorized project root. Preserve existing content and avoid duplicating documented decisions. Add confirmed domain terms to `CONTEXT.md`; add settled decision entries to `DECISIONS.md`. Never delete memory files during harvesting.

Report sessions scanned, access denials or manual inputs, decisions extracted and deduplicated, conflicts resolved or left open, files changed, and cleanup suggestions. Do not quote sensitive source text in the report.
