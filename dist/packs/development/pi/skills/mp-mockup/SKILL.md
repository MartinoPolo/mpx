---
description: Generates self-contained HTML variant mockups from a design brief, one by default or N in parallel,...
disable-model-invocation: true
metadata:
  author: MartinoPolo
  category: design
  version: "0.3"
name: mp-mockup
---

# Design Mockup Generation

Generate self-contained HTML mockup(s) from a design brief, in the project's own design language.

Shared conventions — folder layout, project discovery, mockup HTML rules, container context:
[DESIGN_PIPELINE.md](../../../../../pi/instructions/shared/DESIGN_PIPELINE.md). Use only approved machine-root
context supplied by the native session; do not guess external paths.

## Arguments

- Leading number N (1–5) → N variants; the rest is the component name.
- No leading number → 1 variant; the whole argument is the component name.
- No arguments → 1 variant for the next brief that has none.
- `all` / `N all` → every component with a brief and no variants.

```
/skill:mp-mockup                        → 1 variant, auto-detected component
/skill:mp-mockup 3                      → 3 variants, auto-detected component
/skill:mp-mockup settings-panel         → 1 variant for settings-panel
/skill:mp-mockup 3 settings-panel       → 3 variants for settings-panel
```

## Step 1: Read the design language

`designs/DESIGN_SYSTEM.md` for classes, patterns, and spacing. No design system file → infer per
DESIGN_PIPELINE.md § Project discovery. Leave `designs/tokens.css` unread — mockups link it.

## Step 2: Identify the target brief

Named component → `designs/<component-name>/DESIGN_BRIEF_<COMPONENT_NAME>.md`. Auto-detect → the
folder under `designs/` that has a brief and no `variants/variant-*.html`.

## Step 3: Discover reusable components

Scan the project's component directories and read real props and variants from source, variants
files, or stories. For a pattern nothing covers, spawn `mpx-context7-docs-fetcher` against the
project's component library — note it and defer installation to `mp-design-refine`.

## Step 4: Generate

Output into `designs/<component-name>/variants/`.

**N = 1** — write `variant-a.html` directly.

**N > 1** — spawn N `mpx-ui-variant-generator` agents in parallel, one per variant. Give each agent:

- **Style definition** — the project's design language: font families, palette tokens, spacing
  scale, radius, shadow and motion rules, all from `designs/DESIGN_SYSTEM.md` or the discovered
  global stylesheet. Identical across variants: the design system is fixed.
- **Variant angle** — what makes this one distinct. Vary layout structure, information density,
  hierarchy and emphasis, and progressive disclosure. Keep the angles far apart, e.g. `a` dense
  table-first, `b` airy card grid, `c` split master-detail.
- **Functional requirements** — the brief verbatim, including all states and the surrounding context
  section.
- **Framework** — `html`.
- **Output file** — the absolute path to `variants/variant-<letter>.html`, single self-contained
  file, no `VARIANT.md`.
- **HTML rules** — DESIGN_PIPELINE.md § Mockup HTML rules, including the container context rule and
  the eyebrow label naming the variant's angle.

## Step 5: Open

Open each variant by `file:///` URL through Chrome DevTools MCP when available. Leave the tabs open
side by side for comparison.

## Step 6: Report

Each variant: letter, one-line angle, file path. Close with the next command —
`/skill:mp-design-refine <variant-letter> <requirements>` produces `refined.html` and `SUMMARY.md`.
