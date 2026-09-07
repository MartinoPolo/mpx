# Design Pipeline

Shared conventions for design initialization, briefs, variants, and refinement.

## Pipeline and layout

| Stage                 | Runs               | Produces                                         |
| --------------------- | ------------------ | ------------------------------------------------ |
| design initialization | once per project   | `designs/DESIGN_SYSTEM.md`, `designs/tokens.css` |
| design brief          | once per component | brief and semantic `Design needed` label         |
| mockup                | after the brief    | `variants/variant-<letter>.html`                 |
| refinement            | after selection    | `refined.html`, `SUMMARY.md`, label removal      |

```text
designs/
├── DESIGN_SYSTEM.md
├── tokens.css
└── <component-name>/
    ├── DESIGN_BRIEF_<COMPONENT_NAME>.md
    ├── refined.html
    ├── SUMMARY.md
    └── variants/
        ├── variant-a.html
        └── DECISION.md
```

The brief remains the authoritative requirements; `refined.html` is the authoritative visual design after refinement.
Keep rejected variants and the decision record for context.

## Discover project specifics

Assume nothing about the stack. At the start of each stage discover:

1. **Design language** — read `designs/DESIGN_SYSTEM.md` and `designs/tokens.css`, then locate the global stylesheet
   (common examples include `src/app.css`, `src/styles/global.css`, and `app/globals.css`). Never carry fonts or palette
   from another project.
2. **Component paths** — first inspect framework or library configuration. For example, resolve shadcn `components.json`
   aliases such as `aliases.ui` and `aliases.components`. Then search likely source trees (`src/**/components/`,
   `app/components/`, `lib/components/`) rather than assuming one fixed path. Distinguish vendored primitives from
   project compositions.
3. **Component APIs** — read source, variant definitions such as `*-variants.ts`, and stories such as `*.stories.*` for
   real import paths, props, and variants.
4. **Framework and package manager** — identify the framework from dependencies. Select the package manager by lockfile
   first: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lock*` → bun, `package-lock.json` → npm; only then use
   `package.json#packageManager`. Corresponding one-off executors are `pnpm dlx`, `yarn dlx`, `bunx`, and `npx`.
5. **Library APIs** — use the approved documentation route rather than memory.

Use [EXPLORATION.md](EXPLORATION.md) for search boundaries and spawn `mpx-context7-docs-fetcher` for library
documentation.

## Mockup HTML

Every variant and refined HTML file:

- links the project token file instead of copying token values: from `designs/<component>/variants/variant-a.html` use
  `../../tokens.css`; from `designs/<component>/refined.html` use `../tokens.css`. If no token file exists, inline only
  the discovered project custom properties;
- loads fonts the project already uses and applies the project's actual utility/design-system classes where those
  classes are available to the standalone document;
- limits custom CSS to the component and surrounding layout rather than recreating the design system;
- uses domain-realistic names, paths, dates, statuses, metrics, and copy derived from project concepts—not generic
  placeholders or invented production claims;
- includes an eyebrow naming the variant and its design angle and renders at approximately 1440×900 proportions;
- preserves applicable responsive behavior, semantic structure, keyboard/focus treatment, contrast, and brief-required
  loading, empty, error, disabled, and interaction states.

When a brief requests surrounding context, render finished neighbors at full fidelity and unfinished neighbors as muted,
non-editable context. The designed component owns only its area; parent chrome stays with the parent. A standalone
component owns its complete chrome.

## Design gate

`Design needed` is a semantic MPX Issue gate. Apply and remove it through the documented operations in
[ISSUE_TRACKER.md](ISSUE_TRACKER.md), after resolving and verifying the explicit provider target. Inspect existing
labels or columns for an equivalent mapping first. If none exists, ask before creating a supported label or mapping the
gate to another value. Unsupported operations produce a structured manual handoff; never silently skip or invent the
gate.

## Model policy

Design and architecture require the `advanced` model class with task-matched effort. Canonical agent definitions declare
classes; call sites omit concrete model IDs. If a generic agent has no class declaration, the caller must pass
`advanced`. See [SUBAGENT_PROTOCOL.md](SUBAGENT_PROTOCOL.md).
