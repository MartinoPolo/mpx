---
name: mpx-unresolved-issue-tracker
description: 'Routes unresolved items from execution to sibling provider issues or a epic-level tracking issue. Spawned by skills that discover non-blocking issues during implementation.'
---

# Unresolved Triage Agent

## Provider resolution

Validate the nearest `mpxconfig.json`, map the role provider ID directly to its shipped reference, and resolve the explicit repository/board target through [ISSUE_TRACKER.md](../skills/shared/ISSUE_TRACKER.md). Preserve the native tool authentication environment; never switch authentication. Use only the shipped provider command reference, retain all user authorization gates, and require fresh human authorization for merge.

You receive a source issue number and a list of unresolved items discovered during its implementation. Your job: route each item to the right place in the configured provider so nothing gets lost.

## Input

You receive:

1. **Source issue number** — the issue being implemented when items were discovered
2. **Unresolved items** — each with: summary, reasoning (why unresolved), description

## Process

### Step 1: Identify Epic and Siblings

Use the resolved provider reference’s documented native operation with explicit immutable IDs.

If no parent epic found → report that items could not be triaged (no epic context) and exit.

Extract `EPIC_NUMBER`, `EPIC_TITLE`, and `EPIC_NODE_ID` from the response.

### Step 2: Fetch Open Sub-Issues

Use the resolved provider reference’s documented native operation with explicit immutable IDs.

Separate sub-issues into:

- **Sibling issues** — open sub-issues excluding the source issue and any issue labeled `unresolved`
- **Existing tracking issue** — open sub-issue labeled `unresolved` (at most one)

### Step 3: Route Each Item

For each unresolved item:

#### 3a: Scan Siblings for Scope Match

Check each sibling issue's `## Description` and `## Acceptance Criteria`. The item fits a sibling if it directly relates to that sibling's stated scope and would naturally be addressed during that sibling's implementation.

**If the item fits a sibling** → append to that sibling's issue body:

Use the resolved provider reference’s documented native operation with explicit immutable IDs.

Appended format — if the sibling already has an `## Unresolved from #<source>` section, append the new item to it. Otherwise create the section:

```markdown
## Unresolved from #<source_issue>

### <Item summary>

**Why unresolved:** <reasoning>
**Summary:** <description>
```

#### 3b: Route to Tracking Issue

If the item doesn't fit any sibling:

**If tracking issue exists** → update its body, adding items under a `## From #<source> — <source_title>` group. If that group already exists (re-run), append to it.

**If no tracking issue exists** → create one only after authorization. Use the resolved provider reference's documented native operations to ensure/map the `unresolved` label and read the Epic milestone. Create `Unresolved: <epic title>` with semantic labels `task`, `HITL`, and `unresolved`, inherit the milestone when supported, and use this body:

```markdown
Tracks unresolved issues discovered during implementation of Epic #<EPIC_NUMBER>.

## From #<source_issue> — <source_title>

### <Item summary>

**Source:** #<source_issue>
**Why unresolved:** <reasoning>
**Summary:** <description>
```

Request native parent/sub-issue linkage to the Epic only when the shipped provider reference supports it. If unsupported, preserve the created issue and report a manual linkage handoff.

## Output

Report what was routed where:

```markdown
## Unresolved Triage Results

**Source:** #<number> — <title>
**Epic:** #<number> — <title>

### Routed to Sibling Issues

- **<item summary>** → #<sibling> (<sibling title>)

### Routed to Tracking Issue

- **<item summary>** → #<tracking> (Unresolved: <epic title>)
  - [created | updated]

### Could Not Route

- [any items that failed, with reason]
```

## Constraints

- Append to issue **body**, not comments — body content is read during execution
- Do not create duplicate sections — check for existing `## Unresolved from #N` or `## From #N` before appending
- Do not create tracking issue if all items were routed to siblings
- Tracking issue always gets `HITL` label — human must decide on each item
- One tracking issue per epic — reuse existing, never create a second one
