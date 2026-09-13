---
name: consolidate-context
description:
  'Consolidates CONTEXT.md by removing duplicates and outdated items and tightening the language.'
metadata:
  author: MartinoPolo
  version: '2.3'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

Consolidate `.mpx/CONTEXT.md` into a concise, future-proof reference. Preserve all important detail
while removing noise.

Read [Documentation Strategy]({{MPX_SHARED_INSTRUCTIONS}}/DOCUMENTATION_STRATEGY.md) for format details. Resolve it
relative to this loaded skill first. If runtime projection relocation makes that impossible, read
`MPX_ACTIVE_CONTENT_ROOT`, require it to be an absolute path, resolve
`dist/{{MPX_HARNESS}}/instructions/shared/DOCUMENTATION_STRATEGY.md` beneath it, and verify that the literal result exists and
remains contained by that root. Stop if validation fails. Do not search ordered roots or guess an
installation checkout.

## Input Resolution

1. If `the invocation input` is a file path, use that file.
2. Otherwise, use `.mpx/CONTEXT.md`.
3. If not found, ask the user for the path.

## Process

### Step 1: Read & Analyze

Read every line of the full file against each issue type and build a classified findings list:

#### Issue Type: **Duplicates**

- **What to Look For:** Terms or features covering the same concept (keep the most current/complete
  version)

#### Issue Type: **Superseded**

- **What to Look For:** Content explicitly marked as superseded, replaced, or overridden by newer
  entries

#### Issue Type: **Negative framing**

- **What to Look For:** "must not", "cannot", "never" — convert to positive imperative

#### Issue Type: **Non-content noise**

- **What to Look For:** Implementation notes, deviation notes, historical provenance, issue-tracking
  meta, "Plan vN" / date labels

#### Issue Type: **Outdated**

- **What to Look For:** Struck-through items, removed parameters still referenced, resolved issue
  references

#### Issue Type: **Inconsistencies**

- **What to Look For:** Conflicting definitions or specifications

#### Issue Type: **Bloated definitions**

- **What to Look For:** Domain Language definitions exceeding one sentence

#### Issue Type: **Misplaced content**

- **What to Look For:** Architectural decisions that belong in DECISIONS.md, implementation details
  that belong in epics

### Step 2: Rewrite

Apply all changes directly and automatically. Produce the consolidated file:

- § Domain Language: one sentence max per definition, definition-list format
  (`**Term** — Definition.`)
- § Core Features: index only (name + status + epic#), no implementation details
- § Key Constraints: concise bullets
- § Flagged Ambiguities: resolved term conflicts with rationale
- Target 250–300 lines total

**Content rules:**

- Remove implementation/deviation notes (belong in PRs or commit messages)
- Fix inconsistent values (use the most recent/authoritative source)
- Merge sections that were split by version history into unified topics
- Keep full technical detail where it matters: formulas, ranges, defaults
- Move any settled architectural decisions to DECISIONS.md instead

### Step 3: Write Result

Write the consolidated file to the original path (overwrite), then re-read it to confirm the
intended sections and retained technical details. Git history preserves the original.

## Report

After writing, summarize:

- Line count: original vs. consolidated (and lines saved)
- Items removed, merged, or rewritten (counts)
- Inconsistencies fixed
- Items moved to DECISIONS.md (if any)
