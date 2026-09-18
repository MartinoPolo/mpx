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

Preserve confirmed meaning, technical constraints, and important negative rules. Resolve conflicts
only from authoritative evidence; ask when uncertain. Move settled decisions to the sibling
`DECISIONS.md`, preserving existing content. Split only when stable subject boundaries improve use.

Older `.mpx/REQUIREMENTS.md`, `.mpx/VOCABULARY.md`, and `.mpx/ARCHITECTURE.md` remain read-only
history; do not create, update, or use them as fallback context.

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

- **What to Look For:** Negative phrasing that can be made positive without weakening constraints

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

Apply changes supported by authoritative evidence. Ask about unresolved conflicts before changing
the affected content. Produce the consolidated file:

- § Domain Language: one sentence max per definition, definition-list format
  (`**Term** — Definition.`)
- § Core Features: index only (name + status + configured-provider Issue ID + design pointer), no
  implementation details
- § Key Constraints: concise bullets
- § Flagged Ambiguities: resolved term conflicts with rationale

**Content rules:**

- Remove implementation/deviation notes (belong in PRs or commit messages)
- Fix inconsistent values only when authoritative evidence settles the conflict
- Merge sections that were split by version history into unified topics
- Keep full technical detail where it matters: formulas, ranges, defaults
- Move settled architectural decisions to the sibling `DECISIONS.md` as concise bullets grouped
  by domain. Include useful rationale and only explicitly rejected alternatives; replace superseded
  entries while preserving unrelated decisions.

### Step 3: Write Result

Write the consolidated file to the original path (overwrite), then re-read it to confirm the
intended sections and retained technical details. Git history preserves the original.

## Report

After writing, summarize:

- Line count: original vs. consolidated (and lines saved)
- Items removed, merged, or rewritten (counts)
- Inconsistencies fixed
- Items moved to DECISIONS.md (if any)
