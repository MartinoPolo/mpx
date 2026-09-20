---
name: code-walkthrough
description:
  'Builds a single-file interactive HTML walkthrough that explains a code change (diff, MR, or
  file set) as a slide deck with bidirectional code-to-note linking'
argument-hint: '<change to explain: diff, branch, MR, or file globs> [--mode artifact|local]'
triggers:
  code walkthrough; annotated code slide deck; interactive code review
metadata:
  author: MartinoPolo
  version: '0.1'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Interactive code walkthrough

Build a single self-contained interactive HTML page that explains a code change to a reader who has not seen it. Narrow and opinionated: this skill does ONE thing. It is not a defect review (that is `review`), not a general tutorial (that is `tutorial-create`), not documentation.

Author the page from the contract below in words, every run. There is no template and no compiler — describe-and-build, so the output stays portable and dependency-free.

## Modes

- **artifact** — publish the page through the runtime's artifact-publishing capability. The reviewer feedback loop is then that capability's **native** comment system (a reader comments and routes the thread back to the agent); build nothing for it in the page.
- **local** — write one self-contained `.html` to the repo root and return a `file:///` link. No feedback loop.

Default: **artifact when the runtime can publish artifacts, local otherwise.** Honor `--mode` when given. Page content is identical across modes; only delivery differs.

## Workflow

### Step 1: Parse request and resolve mode

From the invocation input determine the **change to explain** (a working diff, a branch vs the main branch, an MR, or explicit file globs) and the **mode** (rule above; `--mode` overrides). Derive a stable kebab-case **slug** from the branch or topic.

### Step 2: Gather the change

Read the actual code before deciding anything — never explain from a diff header alone.

- Scope the diff: `git diff --stat` then `git diff -- <paths>` against the merge base, or read the named files. Delegate to a read-only exploration sub-agent only when the change spans more than three files or ~1000 lines; otherwise read directly.
- Enumerate every **new or changed function, method, and exported interface in a core (shipped) file**. Exclude tests, stories, fixtures, harnesses, debug/tooling. This exclusion list is fixed.
- For each, capture its signature, what it does, the constraint that forces it to exist, and the one non-obvious decision inside it. This is the raw material for the slides.

### Step 3: Slide-map gate — always stop here

Present the plan and **wait for approval before writing the page**. A mis-scoped deck is a rewrite, not an edit.

Show, compactly:

- resolved mode, slug, and diff scope (files, added/changed function count)
- the numbered slide list, starting with **Implementation vocabulary** and its proposed terms; for subsequent slides use `Slide N — <function or tight group> (Lxx-yy in <file>)`
- after vocabulary, ordering by **reading dependency** (types/profile → parsers/helpers → callers), not file order
- what is deliberately excluded (every test/story/debug symbol, and any trivial rename)

Then ask for approval or adjustments; re-show if the shape changes.

### Step 4: Build the page — design contract

Author one HTML file. In **local** mode write it to `<repo root>/<slug>-walkthrough.html` (a temporary, uncommitted file). In **artifact** mode write it to that same path, then publish it (favicon, a two-to-four-word title, one-sentence description).

Every rule below is fixed. Do not re-litigate them per run.

**Format**

- **Slides, one feature per slide.** A feature is one new/changed function, or one tightly coupled group (a parser and its private helper). Never two unrelated features on a slide.
- **Two-column slide:** code left (sticky), notes/demo right. Collapse to one column on narrow viewports (about 860px).
- **Vocabulary is the opening exception:** use a readable glossary layout rather than one function and a code panel. Split across consecutive opening slides if needed; do not omit important terms to fit.
- **No outline, no navigation sidebar, no contents rail.** Slides plus keyboard navigation are the only navigation. This is deliberate — a rail reads as distracting here.
- **Use the full viewport width;** do not cap the deck at reading width.
- **Self-contained and portable:** inline all CSS and JS. Load libraries only from the runtime's permitted CDN (pinned exact version) — a syntax highlighter such as highlight.js is the expected one. The page must render identically as a local file and as a published artifact, and keep working offline after first load.
- **Theme-aware:** light/dark via tokens on `:root`, `prefers-color-scheme`, and an explicit toggle. The code panel may stay dark in both themes; linking marks then use fixed hexes (a canonical blue around `#7aa2f7`/`#8bb4ff`) that read on the dark panel regardless of theme.

**Content**

- **Open with Implementation vocabulary.** Explain all important or ambiguous terms used in the implementation: domain language, concepts, variables, and naming verbs. Use plain language grounded in the actual code, distinguish easily confused terms, and show representative identifiers. For function names, explain the key verb (such as *interpret*, *analyze*, *commit*, or *publish*), not merely a paraphrase of the full name; define its meaning here, not a generic dictionary meaning.
- **Explain every new/changed core function in full** — the Step 2 list, nothing skipped, no "and so on".
- One function per slide by default; combine only genuinely coupled functions.
- Each function slide answers three things: what the function does, why it exists (the constraint), and the one non-obvious decision inside it. Never fabricate behaviour or outputs.
- Vocabulary entries cite representative identifiers and their source locations; they do not require code blocks or hover-link chips. On function slides, tie every prose claim to exact line ranges with a `.ref` chip (e.g. `L51-53`, en-dash between numbers); those chips drive the linking, so the numbers must match the code shown in that slide's block.

**Interaction**

- **Bidirectional hover linking.** Hovering a note highlights its code lines; moving over the code highlights the matching note. Match a note to the shown block with the best line-overlap; a ref whose lines fall outside every shown block gets no link.
- **Keyboard navigation with a visible legend.** Arrows / PageUp-PageDown / Home-End move between slides; a key toggles theme. Show the keys in a persistent legend chip or a `?` overlay. The legend is required.
- **Narrow viewports (about 860px): info-pins, not hover.** Tall, scrolled code with no visible notes makes hover linking useless, so render a small `i` pin at each explained line's right edge; activating it opens a bottom-sheet popup containing that note's body. Clone the existing note as the popup content (single source of truth); reserve right padding on the code so pins never cover text.
- **Optional playground:** for a pure, demoable function, embed one live input-to-output box wired to the real logic. Never fake the output; omit the box instead.

**Implementation notes (learned gotchas — honor them)**

- **Highlight is a geometric overlay band, never DOM-wrapped lines.** Wrapping each line in a span fights the highlighter's own syntax spans and breaks text selection. Position an absolute band over the code by *measured* line-height instead.
- **Parse line-height robustly:** read the computed `line-height`; if it is not a finite number treat it as font-size times about 1.62, and if it is a bare number smaller than the font-size multiply it by the font-size. Handles `"21.06px"`, `"normal"`, and unitless `"1.62"`.
- **Extract ref line numbers** by matching all digit runs in the chip text, so `L68` and `L51-53` both work.
- **Re-run any pin/band layout on slide change, on resize, and on load** — geometry measured while a slide is hidden is wrong.
- Wrap every browser-storage access (theme, any collapse state) in try/catch; a published artifact can run where storage throws.
- Follow the CSS colour guide: cool neutrals for surfaces, hot colours reserved for genuine error/warning callouts in the explained code, never for chrome.

### Step 5: Deliver and report

Take one look at the rendered page, fix what that look reveals in a single pass, then deliver. Do not build a screenshot loop.

- **local:** report the `file:///` link and the slide count.
- **artifact:** report the artifact URL and slide count, and note that the reader can comment and route a thread back to the agent for feedback — no extra step in the page.

State plainly any core function you could not fit and why.

## Editing an existing walkthrough

Edit the HTML file directly and, in artifact mode, republish the same file path (same URL). Keep the slug stable. There is no source-vs-generated split — the HTML is the source.
