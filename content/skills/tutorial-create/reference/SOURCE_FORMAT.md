# Tutorial Source Format (`<slug>.source.md`)

Compact authoring syntax compiled by `scripts/compile.js` into a self-contained HTML page. Author ONLY content — all layout/CSS/JS comes from TEMPLATE.html.

## Frontmatter (YAML)

```yaml
---
titl<configured-path>Shadow DOM — Encapsulation for Web Components
subtitl<configured-path>What the shadow root is, why styles don't leak, and how to pierce it when testing.
typ<configured-path>topic              # topic (ends with quiz) | code-showcase (no quiz)
forma<configured-path>standard         # brief | standard (default) | deep — see table below
categor<configured-path>webdev         # OneDrive folder name
slu<configured-path>shadow-dom         # stable; keys localStorage progress — never change after publish
dat<configured-path>2026-07-24
trac<configured-path>Web Components track   # optional topbar subtitle
video<configured-path># 0-2 link cards (real YouTube URLs)
  - titl<configured-path>"Video title"
    channe<configured-path>"Channel Name"
    duratio<configured-path>"12:24"
    ur<configured-path>http<configured-path>www.youtube.com/watch?v=...
glossar<configured-path># term -> definition (HTML-lit<configured-path>code` allowed)
  shadow roo<configured-path>"The hidden DOM subtree attached via `attachShadow()`..."
reference<configured-path># rendered as References card; url = 📄 external, file = 📁 local
  - titl<configured-path>Using shadow DOM
    ur<configured-path>http<configured-path>developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM
  - titl<configured-path>mr241-test-review.html
    fil<configured-path>$MPX_AI_GENERATED/_TUTORIALS/yoursafe-components/mr241-test-review.html
---
```

## Format

| | `brief` | `standard` | `deep` |
| --- | --- | --- | --- |
| Prose budget per section | 60 words | 200 words | unlimited |
| Quiz | rejected | expected (`topic`) | expected (`topic`) |
| `:::reveal` | warned | ≤1 per section | ≤1 per section |
| Carries the content | annotated code + notes | prose + code | prose, walkthroughs, diagrams |

`brief` is the default choice for introducing something to a tea<configured-path>readers skim the code and its
notes, not paragraphs. Annotated code is preferred in every `brief` section, though a section that
genuinely has no code (a rationale or a "what's missing" list) may skip it.

The prose budget counts paragraphs, callout bodies, recap bullets and reveal bodies — **not**
annotated-code note bodies, which are where `brief` content is supposed to live. Overruns print a
compile warning and still build; treat the warning as a rewrite instruction, not noise.

The practical consequence in `brief`: **anything that needs explaining goes in an annotated code
block**, and a plain diff is for changes that speak for themselves. Reaching for a paragraph to
explain a diff is the signal you should have annotated it instead.

## Sections

`# <slug> | <Title>` starts a section. Slug is the stable progress key — reuse the exact slug when editing an existing tutorial.

```markdown
# why-shadow-dom | Why encapsulate at all?
```

**Titles must be ≤40 characters** — the contents rail is one column, and a longer title wraps to
four or five lines there. Compile warns past 40. Write the title as a label, not a sentenc<configured-path>Why a linter at all`, not `Why a linter when we already have tsc, svelte-check and Prettier`.

### Contents rail (reader-side)

Progress ring + contents are a 300px left rail, collapsible from the topbar button or `[`. Below
1400px it starts collapsed, because there the rail costs the annotated-code region more width than
it gives back; above, it starts open. An explicit toggle is remembered in `localStorage`
(`tutorial-sidebar`) and then wins at every width. Titles still need to fit the rail — it is one
button away at any size.

## Inline markup (in prose, callouts, recap, steps, quiz)

- `**bold**`, `*italic*`, `` `code` ``, `[text](http<configured-path>url)` external link
- `[name](fil<configured-path><configured-path>path)` → clickable local file link, 📁 prefix added automatically
- `((shadow root))` glossary term; `((Display text|shadow root))` when display differs from key

## Annotated code block

Fence with language + optional filename. Mark lines with `//@N` (or `#@N`) at end of line; define notes after the fence as `@<configured-path>Title | body`.

````markdown
```ts user-badge.ts
const shadow = this.attachShadow({ mod<configured-path>"open" }); //@1
```
@1: Open vs. closed mode | `mod<configured-path>"open"` exposes `element.shadowRoot` — essential for tests.
````

Desktop pins each note card beside its marked line and draws a bezier connector between them;
hovering either end highlights the line, the card and the wire. Mobile (≤1100px) renders
tap-to-expand inline cards instead. Same source. Collapsing the contents rail re-measures and
redraws every wire, so the code and cards get the reclaimed width.

Because cards are pinned to their lines, **keep note bodies short** — a tall card pushes every
following card down and its connector stretches into a long vertical sweep. 6-8 notes per block is
the practical ceiling; split a longer listing into two annotated blocks.

## Plain code block

Standard fence, no `//@N` marker<configured-path>ts badge.test.ts `

## Walkthrough (click/hover-driven stepped code)

````markdown
:::walkthrough
```ts user-badge.evolution.ts
...full code, all phases...
```
== 1-9 | Start with a global `<style>`
Step body prose.
== 11-19 | Scope it with attachShadow
Step body prose.
:::
````

`== <lineStart>-<lineEnd> | <Step title>` — line numbers are 1-based into the fenced code.

## Callouts

```markdown
:::info Good to know
Body text.
:::

:::warn Watch out
Body text.
:::
```

## Recap (Key takeaways) — at section end, max one per section

Required in `standard` and `deep`. **Optional in `brief`**, where a three-line section followed by a
recap of the same three lines is the padding the format exists to remove — keep it only when the
takeaway is not already visible in the code.

```markdown
:::recap
- Bullet with **bold** and `code`.
- Second bullet.
:::
```

## Reveal ("Check yourself") — max ONE per chapter, only when it earns it

```markdown
:::reveal Why can't a page-level `.name` selector ever match inside the shadow tree?
Answer body (hidden until clicked).
:::
```

## Quiz — `topic` + `standard`/`deep` only, once, at the very end (after last section)

```markdown
:::quiz
<configured-path>What does `mod<configured-path>"open"` control?
- [ ] Whether outside CSS can style the shadow tree
- [x] Whether `element.shadowRoot` is accessible from outside JS
- [ ] Whether the element can use slots
> Correct-answer explanation shown after any pick.
:::
```

One `<configured-path>block per question; repeat Q/options/`>` inside the same `:::quiz` container.

## Playground (interactive CSS flexbox playground + challenges)

Only for layout/visual-CSS topics. Max ONE per tutorial. Renders mode tabs (Explore + numbered challenges), a live preview, control panel, and a live CSS readout with copy button.

````markdown
:::playground
item<configured-path>3                      # initial item count (min 2, max 6); add/remove available in Explore mode
item-label<configured-path>One | Two longer | Three
containe<configured-path># controls applied to the flex container
  flex-directio<configured-path>row | column | row-reverse | column-reverse
  justify-conten<configured-path>flex-start | center | flex-end | space-between | space-around
  align-item<configured-path>stretch | flex-start | center | flex-end | baseline
  flex-wra<configured-path>nowrap | wrap
  ga<configured-path>0..32 step 8
ite<configured-path># per-item controls (user clicks an item in the preview to select it)
  flex-gro<configured-path>0..3
  flex-shrin<configured-path>0..3
  orde<configured-path>-2..2
  align-sel<configured-path>auto | flex-start | center | flex-end
challenge<configured-path># 2-4 Froggy-style challenges; solved by matching ghost-target geometry (2px tolerance)
  - titl<configured-path>Dead center
    brie<configured-path>Put all items in the exact center of the container.
    hin<configured-path>You need one property per axis.
    item<configured-path>3                  # pins item count for the challenge (add/remove disabled)
    targe<configured-path># flat form = container props only
      justify-conten<configured-path>center
      align-item<configured-path>center
  - titl<configured-path>One rebel
    brie<configured-path>Send the second item to the bottom.
    item<configured-path>3
    targe<configured-path># nested for<configured-path>container props + per-item props (1-indexed)
      containe<configured-path>{ justify-conten<configured-path>center }
      item-2: { align-sel<configured-path>flex-end }
:::
````

Rule<configured-path>- Enum contro<configured-path>a | b | c` — FIRST value is the default. Range contro<configured-path>min..max` with optional `step n` (default 1), default = min. `gap` values render as `<value>px`.
- Challenge `target` may be flat (container props only) or nested `containe<configured-path>item-<configured-path>. Targets may ONLY use declared controls (compile fails otherwise).
- Ghost-matching is geometric — any control combination producing the same layout wins legitimately.
- Completed challenges persist in localStorage keyed by section slug + challenge index; they survive recompiles and stay replayable.

## Mermaid diagram

````markdown
```mermaid
graph LR
  A[Document tree] -->|attachShadow| B[Shadow tree]
```
````

Compiled to inline SVG in two theme variants (light `neutral`, dark `dark`) — the page shows the one matching the active theme. Requires `@mermaid-js/mermaid-cli` (installed via the skill's `pnpm install`); otherwise the build prints a "diagram skipped" warning and omits it.

## Compile

```bash
node scripts/compile.js path/to/<slug>.source.md [--out <dir>]
```

Writes `<slug>.html` beside the source (or to `--out`) and regenerates `$MPX_AI_GENERATED/_TUTORIALS/index.html`.
