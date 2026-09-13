---
description: Compiles an interactive, self-contained HTML tutorial from a topic or code showcase into the...
disable-model-invocation: true
metadata:
  author: MartinoPolo
  category: utility
  version: 1.6.3
name: mp-tutorial-create
---

# Create Interactive Tutorial

Generate a self-contained interactive HTML tutorial page. You author ONLY a compact
`<slug>.source.md`; `scripts/compile.js` renders the final page from `TEMPLATE.html` (Shiki
highlighting, theme, progress, quiz — all template-owned). the invocation input

Resolve bundled references, the template, and scripts relative to this loaded skill. For absolute
filesystem reads, follow [Content Paths](../../../../../../claude/instructions/shared/CONTENT_PATHS.md). Store the loaded skill
directory as `<skill-dir>` and use it in every command; never guess an installation checkout or
treat the caller's directory as the skill directory.

## Workflow

### Step 1: Parse Request

From `the invocation input` infer:

- **Type**: `topic` (concept tutorial, ends with quiz) or `code-showcase` (explains specific
  code/MR/tests, no quiz). Honor `--type` override.
- **Format**: `brief`, `standard` or `deep` — the length/depth budget, documented in
  `reference/SOURCE_FORMAT.md`. Honor `--format`. Default to `brief` whenever the request reads as
  "introduce X to the team", "overview of X", or names an audience that will skim; `standard`
  otherwise. Pick `deep` only on an explicit `--format deep`.
- **Category**: current repo name when the tutorial is about this codebase; otherwise topic area
  (e.g. `webdev`, `typescript`). Honor `--category`. Ask the user only when genuinely ambiguous.
- **Slug**: kebab-case from the title. Stable forever — it keys reader progress in localStorage.

### Step 2: Explore the Topic

Gather the material before deciding the shape: read the actual config/code/tests being documented.
Resolve the canonical `standard` class through the active runtime profile, then spawn a
`general-purpose` sub-agent using the resulting concrete value in the runtime's real `model` field
to find 1-2 intro YouTube videos following [`reference/CHANNELS.md`](reference/CHANNELS.md) (channel
profiles, WebSearch `site:youtube.com` technique, duration filter, oEmbed verification). Pass it the
topic; require back: title, channel, duration, verified URL per video.

### Step 3: Outline Gate — always stop here

Present the plan and **wait for approval before writing any source**. This gate exists because an
unapproved tutorial that turns out too long is a full rewrite, not an edit.

Show, compactly:

- chosen `type` and `format`, with the per-section word budget that implies
- the numbered section list, using the **final ≤40-char titles**
- for each section, one line on what carries it (annotated code / diagram / prose)
- what you are deliberately leaving out (quiz, reveals, benchmark tables, background theory)
- the projected total word count

Then ask for approval or adjustments. Adjust and re-show if the user changes the shape.

### Step 4: Author Source

Resolve only `MPX_AI_GENERATED` from the process environment before writing — `Write` takes a real path, and
`$MPX_AI_GENERATED` written in prose is literal text, not one. Read
[`reference/SOURCE_FORMAT.md`](reference/SOURCE_FORMAT.md), then write `<slug>.source.md` directly
into `$MPX_AI_GENERATED\_TUTORIALS\<category>\`.

Authoring rules:

- **Respect the format budget.** In `brief`, the annotated code and its notes carry the content;
  prose is a one- or two-sentence framing per section, and every sentence that only restates the
  code gets cut. Compile warnings about word counts are rewrite instructions, not noise. When
  something needs explaining, annotate the code instead of writing a paragraph about it — note
  bodies are outside the budget precisely so the explanation lands next to the line it describes.
- **Section titles ≤40 chars** — the contents rail is one narrow column. Write labels
  (`Unused variables`), not sentences. The rail is collapsible (topbar button or `[`, collapsed by
  default below 1400px), so a title still has to fit it when a reader opens it back up.
- **Annotated-code discipline**: 6-8 notes per block maximum, note bodies 1-2 sentences. Cards are
  pinned beside their line with a connector wire, so a fat card pushes everything below it down.
  Split long listings into two blocks.
- **Restraint on reveals**: `brief` omits them entirely; elsewhere, at most ONE "Check yourself"
  `:::reveal` per chapter, reserved for a genuine misconception worth testing.
- **Links everywhere**: every external concept links to canonical docs (MDN, framework docs) inline;
  every referenced local file is a clickable `file:///` link (rendered with 📁) both inline and in
  the `references` frontmatter.
- Every section ends with a `:::recap` — except in `brief`, where it is optional and earns its place
  only when the takeaway is not already visible in the code. Prefer a Mermaid diagram wherever a
  visual replaces a paragraph.
- Glossary: define recurring jargon in frontmatter `glossary`, mark occurrences with `((term))`.
- **Playground restraint**: `:::playground` only for layout/visual-CSS topics (flexbox, grid,
  positioning, transitions); max ONE per tutorial; 2-4 challenges. Challenge targets must be
  achievable with the declared controls. Ghost-matching is geometric, so alternate solutions win
  legitimately — that is intended.

### Step 5: Compile

```bash
node "<skill-dir>/scripts/compile.js" "$MPX_AI_GENERATED/_TUTORIALS/<category>/<slug>.source.md"
```

Shiki and yaml come from the MPX2 package installation. Do not install dependencies or edit files
inside committed skill projections. Mermaid additionally requires `@mermaid-js/mermaid-cli` and
its browser dependency in the MPX2 installation; request explicit dependency setup when needed.
Mermaid blocks compile to inline SVG in light and dark variants. If the optional renderer is missing,
the build prints a "diagram skipped" warning and still succeeds; report that limitation, never claim
the missing diagrams were rendered.

The compiler writes `<slug>.html` beside the source and regenerates
`$MPX_AI_GENERATED\_TUTORIALS\index.html` (dashboard with per-tutorial progress). Editing
TEMPLATE.html and recompiling preserves reader progress — section slugs are the storage keys.

### Step 6: Verify and Report

Fix every title-length and word-budget warning by rewriting the source and recompiling, and report
only once the build is clean:

- Output paths (page + source + index) as clickable `file:///` links
- Type, format, category, section count, videos chosen

## Editing an Existing Tutorial

Edit its `.source.md` (keep existing section slugs!) and re-run compile. Never hand-edit the
generated HTML.
