---
description: Converts Obsidian board notes from the To Process lane into provider-native Issues, deduping against...
disable-model-invocation: true
metadata:
  author: MartinoPolo
  category: project-management
  version: "0.6"
name: mp-board-to-issues
---

# board-to-issues

Turn board notes into well-formed provider-native Issues, optionally narrowed by the invocation
input.

First:

1. Read [Board Convention](../../../../../pi/instructions/shared/BOARD_CONVENTION.md),
   [Provider Routing](../../../../../pi/instructions/shared/PROVIDER_ROUTING.md), and the bundled canonical
   [Issue template](ISSUE_TEMPLATE.md). Resolve bundled assets relative to this loaded skill.
2. Read the nearest valid `mpxconfig.json`. Resolve `issues.provider` independently and load its
   selected native guide under `../../../../../pi/instructions/shared/providers/`. Use only that guide's native Issue
   operations; never invent an MPX facade command or substitute the repository provider.
3. When the Issue provider is KanbanFlow, select only `issues.boardId` (and verify optional
   `boardName`) from `mpxconfig.json`. Never infer or interactively guess a board. Obtain
   credentials only through the selected guide's documented environment/secret flow; never print,
   persist in the repository, or commit credentials.

## Rules

- Conversion is **not** blindly 1:1 — merge related bullets into one issue, and skip notes that
  duplicate an existing open issue.
- Classify HITL only for genuine **unanswered requirement questions**. Visual inspection, manual
  testing, and QA are not HITL reasons.

## Step 1: Read the board

Read `.mpx/BOARD.md`. Fresh notes live under the single `# To Process` intake lane — there is no
section argument. The invocation input is optional free-text guidance (e.g. "only the login bug"),
not a section selector.

## Step 2: Collect items

Collect each `- [ ]` bullet under `# To Process`; skip any that already carries the canonical
`→ issue:<id>` annotation or the legacy `→ #<N>` form (already has an Issue), and ignore everything
under the downstream lanes (`# Ready to implement`,
`# Manual testing`, `# Archive`). Do **not** interpret the checkbox as state — it is the user's
manual-verification flag, not a processing marker. For each item, capture its text (including
continuation lines) and every `![[...]]` image wikilink, and **read each image** at
`.mpx/board-files/<filename>` so the visual context informs the issue.

## Step 3: Merge + dedup

Group bullets that describe the same fix into a single proposed Issue. Use the selected Issue
provider guide's native list/search operations to check open Issues for duplicate keywords. Mark
likely duplicates to skip, recording the provider-native Issue identifier and URL. If search is
unsupported, report that bounded gap and require explicit confirmation before creating.

## Step 4: Draft each issue

For each proposed issue:

- **Body** — follow the canonical Issue template structure (`## Description`, `## Requirements` as
  REQ-1..N, `## Acceptance Criteria`, `## Notes`). Reference screenshots in `## Notes`. Encode
  hierarchy with explicit parent/child body links; never assume provider-native sub-Issue support.
- **Size** — estimate `size:S` (single file / few lines), `size:M` (multi-file, contained), or
  `size:L` (cross-cutting) from complexity.
- **AFK vs HITL** — AFK when scope is clear; HITL when a requirement question is unanswered (add the
  `> **Unanswered questions:**` blockquote).
- **Type** — infer from the note's content (per BOARD_CONVENTION): a defect → `bug`, a
  chore/audit/refactor → `task`, a new capability or improvement → `enhancement`. The note's
  position on the board carries no type information.
- **Labels** — the inferred type + exactly one of `AFK`/`HITL` + `size:<X>` + inferred `area:*`.

## Step 5: Confirm before creating

Present the full plan with the native structured question UI when available: each board bullet →
proposed issue(s), labels, size, AFK/HITL, and any duplicates being skipped. Only create issues after the user confirms the plan
(they may edit it).

**Gate:** Continue only when the user has confirmed or amended the full mapping, including every
skip.

## Step 6: Create issues

Create each confirmed Issue using only the selected provider guide's native create operation,
preserving the approved title, canonical body, labels/tags, and assignee when supported. Capture its
provider-native identifier and URL. If a capability is unsupported or authentication is unavailable,
continue independent drafting and return exact manual steps—do not fall back to another provider or
CLI.

## Step 7: Write back to the board

For each created Issue, `Edit` `.mpx/BOARD.md` to **move** its item from `# To Process` to
`# Ready to implement` and append the canonical ` → issue:<id>` using the returned provider-native
identifier. **Leave the checkbox marker as `- [ ]` — never write `- [x]` or `- [/]`; the checkbox is
the user's alone.** This annotation is what `batch-execute` uses to close the loop.
(`.mpx/BOARD.md` is a symlink — if Edit/Write refuses it, resolve to the real vault path and edit
that; see BOARD_CONVENTION.)
Verify that every created issue's item appears exactly once in `# Ready to implement`, has its
matching annotation, and no longer appears in intake.

## Step 8: Offer to resolve HITL

If any HITL issues were created, offer to resolve them now by running `/skill:mp-hitl` (grill the open
questions → flip `HITL`→`AFK`), which makes them batch-executable.

## Report

List: resolved Issue provider and configured board when applicable; created Issues (identifier, URL,
title, labels/tags, size); merged bullets; skipped duplicates (identifier and URL); board writeback
verification; HITL Issues awaiting resolution; unsupported provider capabilities; and authentication
facts/gaps without exposing secret values.
