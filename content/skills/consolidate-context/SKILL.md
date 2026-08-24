---
name: consolidate-context
description: "Consolidates CONTEXT.md by removing duplicates and outdated items and tightening the language."
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: name-only
---
Consolidate `.mpx/CONTEXT.md` into a concise, future-proof reference. Preserve all important detail while removing noise.

See `skills/shared/DOCUMENTATION_STRATEGY.md` for format details.

## Input Resolution

1. If `the invocation input` is a file path, use that file.
2. Otherwise, use `.mpx/CONTEXT.md`.
3. If not found, ask the user for the path.

## Process

### Step 1: Read & Analyze

Read the full file. Scan for each issue type and build a findings lis<configured-path>| Issue Type | What to Look For |
|---|---|
| **Duplicates** | Terms or features covering the same concept (keep the most current/complete version) |
| **Superseded** | Content explicitly marked as superseded, replaced, or overridden by newer entries |
| **Negative framing** | "must not", "cannot", "never" — convert to positive imperative |
| **Non-content noise** | Implementation notes, deviation notes, historical provenance, issue-tracking meta, "Plan vN" / date labels |
| **Outdated** | Struck-through items, removed parameters still referenced, resolved issue references |
| **Inconsistencies** | Conflicting definitions or specifications |
| **Bloated definitions** | Domain Language definitions exceeding one sentence |
| **Misplaced content** | Architectural decisions that belong in DECISIONS.md, implementation details that belong in epics |

### Step 2: Rewrite

Apply all changes directly and automatically. Produce the consolidated fil<configured-path>- § Domain Languag<configured-path>one sentence max per definition, definition-list format (`**Term** — Definition.`)
- § Core Feature<configured-path>index only (name + status + epic#), no implementation details
- § Key Constraint<configured-path>concise bullets
- § Flagged Ambiguitie<configured-path>resolved term conflicts with rationale
- Target 250–300 lines total

**Content rules:**
- Remove implementation/deviation notes (belong in PRs or commit messages)
- Fix inconsistent values (use the most recent/authoritative source)
- Merge sections that were split by version history into unified topics
- Keep full technical detail where it matter<configured-path>formulas, ranges, defaults
- Move any settled architectural decisions to DECISIONS.md instead

### Step 3: Write Result

Write the consolidated file to the original path (overwrite). Git history preserves the original.

## Report

After writing, summariz<configured-path>- Line coun<configured-path>original vs. consolidated (and lines saved)
- Items removed, merged, or rewritten (counts)
- Inconsistencies fixed
- Items moved to DECISIONS.md (if any)
