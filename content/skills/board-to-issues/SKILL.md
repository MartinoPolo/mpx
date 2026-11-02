---
name: board-to-issues
description:
  'Converts unchecked notes from the Obsidian project note Inbox into provider-native Issues,
  deduping against open Issues and removing converted notes...'
metadata:
  author: MartinoPolo
  version: '0.8'
  category: project-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# board-to-issues

Turn Inbox notes into well-formed provider-native Issues, optionally narrowed by the invocation
input.

First:

1. Read [Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md),
   [the Issue template]({{MPX_SHARED_INSTRUCTIONS}}/ISSUE_TEMPLATE.md), and
   [Project Inbox]({{MPX_SHARED_INSTRUCTIONS}}/PROJECT_INBOX.md).
2. Resolve project configuration as specified by Provider Routing, then select `issues.provider`.
   Load its selected native guide under `{{MPX_SHARED_INSTRUCTIONS}}/providers/`. Use only that guide's native Issue
   operations; never invent an MPX facade command or substitute the repository provider.
3. For KanbanFlow, follow the selected guide’s board-identity validation using `issues.metadata.boardId`
   and optional `issues.metadata.boardName`. Native tools own authentication; credentials remain in the OS keyring.

## Rules

- Conversion is **not** blindly 1:1 — merge related bullets into one issue, and skip notes that
  duplicate an existing open issue.
- Classify HITL only for genuine **unanswered requirement questions**. Visual inspection, manual
  testing, and QA are not HITL reasons.

## Step 1: Collect items

Locate the project note and collect its eligible Inbox items as Project Inbox specifies. The
invocation input is optional free-text guidance (e.g. "only the login bug"), not a section selector.

## Step 2: Merge + dedup

Group bullets that describe the same fix into a single proposed Issue. Use the selected Issue
provider guide's native list/search operations to check open Issues for duplicate keywords. Mark
likely duplicates to skip, recording the provider-native Issue identifier and URL. If search is
unsupported, report that bounded gap and require explicit confirmation before creating.

## Step 3: Draft each issue

For each proposed issue:

- **Body** — follow the Issue template. Put each note image in the section it supports, attached
  from its resolved vault file through the provider guide.
- **Size** — estimate `size:S` (single file / few lines), `size:M` (multi-file, contained), or
  `size:L` (cross-cutting) from complexity.
- **Labels and assignee** — per the Issue template, plus `size:<X>`. Infer the type from the note's
  content.

## Step 4: Confirm before creating

Present the full plan with the native structured question UI when available: each Inbox bullet →
proposed issue(s), labels, size, AFK/HITL, and any duplicates being skipped. Only create issues after the user confirms the plan
(they may edit it).

**Gate:** Continue only when the user has confirmed or amended the full mapping, including every
skip.

## Step 5: Create issues

Create each confirmed Issue using only the selected provider guide's native create operation,
preserving the approved title, canonical body with its attached images, labels/tags, and assignee
when supported. Capture its provider-native identifier and URL, and verify its images uploaded. If
a capability is unsupported or authentication is unavailable, continue independent drafting and
return exact manual steps—do not fall back to another provider or CLI.

## Step 6: Remove converted notes

Once every Issue a bullet maps to exists with its images, remove that bullet from the Inbox as
Project Inbox specifies. Leave skipped duplicates and bullets whose Issue creation failed in place.

## Step 7: Offer to resolve HITL

If any HITL issues were created, offer to resolve them now by running `{{MPX_SKILL_COMMAND}}grill` on each (grill the open
questions → flip `HITL`→`AFK`), which makes them batch-executable.

## Report

List: resolved Issue provider and configured board when applicable; project note path; created
Issues (identifier, URL, title, labels/tags, size); merged bullets; skipped duplicates (identifier
and URL); Inbox removal verification and bullets left in place; HITL Issues awaiting resolution;
unsupported provider capabilities; and authentication facts/gaps without exposing secret values.
