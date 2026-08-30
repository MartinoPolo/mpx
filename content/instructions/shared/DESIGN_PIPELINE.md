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

The brief remains the authoritative requirements; `refined.html` is the authoritative visual
design after refinement. Keep rejected variants and the decision record for context.

## Discover project specifics

Assume nothing about the stack. At the start of each stage discover:

1. Design language and tokens from `designs/`, then global styles and existing components.
2. Fonts and palette from project sources; never carry them from another project.
3. Component directories from framework configuration, then repository search. Distinguish
   vendored primitives from project compositions.
4. Real component APIs from source, variant definitions, or stories.
5. Framework from dependencies and package manager from lockfiles, then `packageManager`.
6. Third-party API details through the approved documentation route; do not rely on memory.

Use [EXPLORATION.md](EXPLORATION.md) for search boundaries and spawn
`mpx-context7-docs-fetcher` for library documentation.

## Mockup HTML

Every variant and refined HTML file:

- links `tokens.css` with the correct relative path, or inlines discovered project custom
  properties only when no token file exists;
- loads the project's actual fonts and uses its classes;
- limits custom CSS to component layout rather than duplicating token values;
- uses realistic data and an eyebrow naming the variant and its design angle;
- renders at approximately 1440×900 proportions.

When a brief requests surrounding context, render finished neighbors at full fidelity and
unfinished neighbors as muted, non-editable context. The designed component owns only its area;
parent chrome stays with the parent. A standalone component owns its complete chrome.

## Design gate

`Design needed` is a semantic MPX Issue label. Apply it through
[ISSUE_TRACKER.md](ISSUE_TRACKER.md) when the brief starts and remove it after refinement. First
read the issue to discover whether an equivalent semantic label is already mapped. Unsupported
label operations produce a structured manual handoff; never silently skip the gate.

## Model policy

Design and architecture require the `advanced` model class with task-matched effort. Canonical
agent definitions declare classes; call sites omit concrete model IDs. If a generic agent has no
class declaration, the caller must pass `advanced`. See [SUBAGENT_PROTOCOL.md](SUBAGENT_PROTOCOL.md).
