---
name: design-refine
description:
  'Applies refinement requirements to a chosen mockup variant, producing refined.html and
  SUMMARY.md,...'
metadata:
  author: MartinoPolo
  version: '0.4'
  category: design
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Design Refinement

Apply refinement requirements to a chosen variant. Produces `refined.html` and `SUMMARY.md`, updates
the design brief, and clears the design gate on dependent issues/tasks in the project's tracker.
Resolve which tracker CLI and how to run each verb via
[ISSUE_TRACKER.md]({{MPX_SHARED_INSTRUCTIONS}}/ISSUE_TRACKER.md).

Use supplied machine roots for external resources; do not guess external paths.

## Step 1: Parse arguments

Argument `all` → [Batch mode](#batch-mode). Otherwise:

- **Variant** — first token, a letter A–Z, case-insensitive
- **Refinements** — everything after it

`B make header sticky, use Badge for status, add empty state` → variant B, three refinements.

Ask for the variant if it is missing, and for the changes if the refinements are empty.

## Step 2: Locate source files

1. Infer the active component from context, else the most recently modified folder under `designs/`
   that has variants.
2. Read `designs/<component-name>/variants/variant-<letter>.html`.
3. Read `designs/<component-name>/DESIGN_BRIEF_<COMPONENT_NAME>.md` in full.
4. Read available `designs/DESIGN_SYSTEM.md`, `designs/tokens.css`, and the global stylesheet.
   Infer missing guidance from this project's existing UI, not another project.

## Step 3: Inventory components

Locate component directories through framework/library configuration and aliases, then source
searches. Distinguish vendored primitives from project compositions. For components named in the
brief or refinements, read real props and variants from source, variants files, or stories and note
the gaps.

## Step 4: Adopt missing components

For each gap:

1. Spawn `mpx-context7-docs-fetcher` against the project's component library.
2. Install with the project's configured package manager and its supported one-off executor.
   shadcn projects: `<pm-exec> shadcn@latest add <name> --yes --overwrite`, using
   `shadcn-svelte@latest` on Svelte. Other libraries: their documented install command.
3. Record the adoption in `SUMMARY.md`.

## Step 5: Write `refined.html`

Write `designs/<component-name>/refined.html`.

Use the project's fonts, available classes, and tokens; link `../tokens.css`. If tokens are absent,
inline only discovered custom properties. Limit custom CSS to the component and layout. Use
realistic domain content without invented production claims. Preserve required states, responsive
behavior, semantics, contrast, and keyboard focus. Reproduce settled surrounding UI faithfully,
mute unfinished neighbors as non-editable context, and preserve component/chrome ownership; a
standalone component owns its complete chrome.

Apply:

- The chosen variant as visual and structural base
- **Every** refinement requirement applied
- Every state from the brief, not just the happy path
- Eyebrow label `REFINED — Variant <X> + <short refinement summary>`

## Step 6: Write `SUMMARY.md`

`designs/<component-name>/SUMMARY.md`. Requirements, states, and layout rules stay in the brief —
the summary carries only implementation-relevant decisions and the component map.

```markdown
# <Component Name> — Design Summary

**Base**: Variant <X> | **Refined**: <date>

## Refinements Applied

Variant <X> refined with: [comma-separated list]. See the design brief for full requirements. Key
structural changes from the base variant: [1–3 sentences].

## Component Map

### Codebase — use as-is

| Component | Path                | Usage         | Key Props/Variants          |
| --------- | ------------------- | ------------- | --------------------------- |
| Button    | `<discovered path>` | [where + how] | `variant="ghost" size="sm"` |

### Adopt

| Component | Source    | Install command         | Purpose          |
| --------- | --------- | ----------------------- | ---------------- |
| [name]    | [library] | `<detected pm command>` | [what it covers] |

### Build custom

| Proposed Name | Description    | Why existing components don't cover it |
| ------------- | -------------- | -------------------------------------- |
| [name]        | [what it does] | [reason]                               |

## Implementation Notes

[Animation approach, event model, accessibility, keyboard nav, scroll behaviour, edge cases. Only
what is not already in the brief.]
```

## Step 7: Update the brief

Insert below the `# Title` heading:

```markdown
> **Status**: Refined (Variant <X>) **Refined mockup**: `designs/<component-name>/refined.html`
> **Summary**: `designs/<component-name>/SUMMARY.md` **Refinements**: [comma-separated short list]
```

Refinement that reveals a missing or wrong requirement fixes it in the brief's own section rather
than recording it in the summary. The brief remains authoritative for requirements; `refined.html`
is authoritative for the refined visual design. Preserve rejected variants and `variants/DECISION.md`
when present.

## Step 8: Comment on the tracker issue/task

Ask for the design issue/task number if unknown, resolve and verify the explicit target using
[ISSUE_TRACKER.md]({{MPX_SHARED_INSTRUCTIONS}}/ISSUE_TRACKER.md), then comment with the selected provider reference's
exact documented operation and this body:

```markdown
## Design Refined

Variant **<X>** refined: [comma-separated refinements]

**Artifacts:**

- `designs/<component-name>/refined.html` — open in browser to review
- `designs/<component-name>/SUMMARY.md` — component map + implementation notes
- `designs/<component-name>/DESIGN_BRIEF_<COMPONENT_NAME>.md` — updated brief
```

## Step 9: Unblock dependent issues

Run this only once the user has reviewed `refined.html` and approved it. Before approval, report
"Pending user approval — re-run the unblock pass once approved" and leave every label in place.

Resolve the `Design needed` gate from existing tracker labels/columns using the selected provider
reference. If it is absent, ask the user to authorize creating it where supported or to provide the
intended mapping; do not invent one. Verify the explicit provider target before mutation. If an
operation is unsupported or blocked, leave affected gates unchanged and report the target, operation,
blocker, and required manual action rather than claiming they were cleared.

1. **Find candidates** — these signals are complementary, use whichever return results:

   - the design issue/task's child tasks
   - open issues/tasks referencing `designs/<component-name>`
   - open issues/tasks carrying the `Design needed` gate that mention `<component-name>`

   Also parse open issue/task bodies for `Blocked by #<design-issue>`.

2. **Filter** to issues/tasks that genuinely depend on this design — skim the body when uncertain,
   so unrelated ones keep their labels.
3. **Remove the gate** — clear the `Design needed` label from each confirmed dependent.
4. Feed the results into Step 10.

## Step 10: Open and report

Open `refined.html` through Chrome DevTools MCP when available, no screenshot — the user reviews it
themselves.

Report in this order:

1. **Artifacts** — `refined.html`, `SUMMARY.md`, brief updated
2. **Component map** — counts only: N reuse, N adopted, N custom
3. **Unblocked** — `#<num> — <title>` per issue whose gate was cleared
4. **Ready to execute** — those unblocked issues carrying no other open `blocked-by`, so the user
   knows what can go to `{{MPX_SKILL_PREFIX}}execute` next
5. **Still blocked** — candidates left labelled, one line of reason each

## Batch mode

Argument `all`: refine every design folder whose variant choice is recorded but unprocessed.
Procedure: [BATCH_MODE.md](BATCH_MODE.md).
