---
description: Loads the mp-handoff skill when explicitly referenced.
metadata:
  author: MartinoPolo
  category: project-management
  version: "0.8"
name: mp-handoff
---

# Session Handoff

Create or update `HANDOFF.md` in the project root — a general session summary for continuity.

## Purpose

Capture accumulated knowledge, context, and insights that would be lost when starting a new
conversation. `HANDOFF.md` persists in the project root and is updated at the end of each session.

## Workflow

### Step 1: Gather context

Review the current conversation and durable work to extract:

- what was accomplished;
- decisions and their reasoning;
- problems encountered and how they were solved;
- dead ends discovered — what not to repeat;
- files modified or discovered; and
- patterns and relationships identified.

### Step 2: Check task state

Inspect task state already available through the native harness, the current conversation, and
project-owned durable artifacts:

- completed work;
- in-progress work; and
- pending work.

Do not require an MPX task-state service or enumerate other native sessions. If a native task list
is unavailable, derive only what the conversation and durable artifacts support and say so in
Working Memory; do not invent status.

### Step 3: Identify project context (optional)

1. Check whether `.mpx/` exists.
2. If it does, read `.mpx/CONTEXT.md` for domain language and feature context.
3. Read `.mpx/DECISIONS.md` for settled decisions.
4. Use these as authoritative enrichment, not as content to duplicate wholesale.

### Step 4: Create or update HANDOFF.md

1. Check whether `HANDOFF.md` already exists in the project root.
2. If it exists, read it and merge current context: preserve still-relevant items and update or
   replace stale ones.
3. Otherwise create it from scratch.

Write only `HANDOFF.md` in the **project root**.

**Target 20–200 lines. Be thorough — this is the only context the next agent gets.** Write as if
briefing a developer with zero context. Every section must contain enough detail to continue without
re-investigating.

```markdown
# Session Handoff

Date: [Today's date]

## Progress This Session

- [For each completed item: what was done and how]
- [Include file paths, function names, and specific changes]
- [Not just "implemented X" — describe the approach]

## Key Decisions

- [What was decided, alternatives considered, and why]
- [Include technical trade-offs and constraints]

## Dead Ends & Mistakes

- [Failed approaches and why: errors, symptoms, wrong assumptions]
- [Promising-looking paths that should not be repeated]

## Bugs Found

- [Fixed or open bugs, reproduction steps, and file locations]

## Next Steps

1. [Prioritized action with enough context to begin immediately]
2. [File paths, symbols, and exact remaining work]
3. [Prerequisites and ordering constraints]

## Critical Files

- `path/to/file` — what it does and why it matters
- [Every file the next agent needs to read or modify]

## Working Memory

- [Implicit dependencies and architectural constraints]
- [Environment quirks, configuration gotchas, and version behavior]
- [Non-obvious component relationships]
```

### Step 5: Confirm

Show the user what was created:

> Session handoff created:
>
> - `HANDOFF.md` (project root)
>
> Captured:
>
> - [x] items of progress
> - [x] decisions
> - [x] next steps

## Notes

- `HANDOFF.md` is updated each session, not deleted.
- This skill writes only `HANDOFF.md`. Decision persistence is a separate workflow:
  `/mp-grill` or `/mp-harvest-decisions`, when available, can
  persist confirmed decisions to `.mpx/DECISIONS.md`. If a companion skill is not installed, record
  that follow-up in Next Steps instead of claiming it ran or writing extra files here.
- Focus on why, not only what — reasoning is crucial.
- Capture implicit knowledge not documented elsewhere.
- Existing handoffs are merged, not blindly overwritten.
