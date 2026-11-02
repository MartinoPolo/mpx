---
name: unfinished
description:
  'Saves this session as unfinished in the Obsidian list so it can be closed and resumed later with
  one click; done ticks it off'
argument-hint: '[note on what is left] | done'
triggers:
  unfinished session; park session; resume later
metadata:
  author: MartinoPolo
  version: '0.2'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [personal]
    defaultExposure: name-only
---

# Save this session as unfinished

In Claude, the MPX prompt hook handles `/mpx-unfinished` without a model turn; in Pi, `/unfinished`
does. Reaching this text means neither ran. Do not continue the task; spend one short turn:

1. Write a `title` of at most 8 words naming the task (not the project). The invocation input, if
   any, is the note on what is left; `done` alone means tick the entry instead.
2. Run `node "<skill-dir>/scripts/unfinished.mjs" [note] --title "<title>" --session "${CLAUDE_SESSION_ID}"`,
   or with `--done` instead of the title and note. Pi does not expand that placeholder; the script
   then finds this session from the working folder.
3. Reply with the script's one-line result and nothing else.

The list is `_Tooling/Unfinished sessions.md` in the Obsidian vault. Each entry links
`agent-launch:resume/<session id>`, which the personal assistant's link handler resumes in Orca.
The morning brief lists open entries.
