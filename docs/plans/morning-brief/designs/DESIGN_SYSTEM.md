# Morning brief: design system

Visual language for [page.html](../../../../content/skills/morning-brief/templates/page.html).
Tokens: [tokens.css](../../../../content/skills/morning-brief/templates/tokens.css). Brand icons
(simple-icons, CC0): [icons/](../../../../content/skills/morning-brief/templates/icons/).

## Identity: sunrise notebook

The shell borrows prejemesi's "Sky Notebook" (`C:\_MP_projects\prejemesi\src\app.css`,
`designs/redesign-2026/sky-final/anime-sky-final.html`). Playful through material: ink outlines,
hard shadows, stickers, tape, a spring ease. No mascots, no decorative emoji.

- **Ground:** sky tint desk (`--desk`) with a 24px dot grid. Light mode is the source of truth.
- **Ink and depth:** `--border-width` ink borders, zero-blur offset shadows (`--shadow-*`), hover
  lift of 2px with `--ease-spring`.
- **Type:** DynaPuff (`--font-head`) only for the date, chapter titles and big numbers; Geist for
  text; Geist Mono with `tabular-nums` for times, counts and refs. Calendar and list text at least
  14px.
- **Marks:** at most a few hand-drawn SVG strokes; rotations of at most 2 degrees on paper props.

## Rules

- **Backgrounds carry information, outlines carry attention.** State is a tinted fill
  (`--fill-*`, calendar colour, account colour); text on a fill stays ink and passes WCAG AA. The
  narrated element gets an outline ring plus a lift; everything else stays readable, never faded
  below 0.6.
- **No left-border accents** on cards, rows, quotes or callouts. Use a fill instead.
- **Native look per chapter.** Each chapter resembles where the data lives, at a glance: Google
  Calendar day columns with solid event blocks, Gmail rows, Slack messages, a Kanban board of GitLab
  or GitHub merge request cards, Obsidian notes, a terminal for session evidence. The brand icon sits in the chapter
  header. Native chrome is simplified and wrapped in the notebook frame (ink border, hard shadow).
- **Reading column.** Every chapter shares one wide centred column (`--reading-width`) so sections
  stay consistent; readability beats density. Prefer cards over full-width rows. Everything on a
  slide is visible without scrolling at 1440×900.
- **Icon-only buttons** with `aria-label` and a tooltip for links and controls; text buttons only
  for confirming choices.
- **Less text than speech.** A slide shows no more words than the narration can cover: titles,
  names, refs, short status words. Detail lives behind links or a disclosure.

## Avoid

From gstack's slop lists (`design-consultation/sections/proposal-and-preview.md`,
`design-review/SKILL.md`): purple gradients, icons in coloured circles, three-column icon grids,
card mosaics, glow, frosted glass, left-border accents, a generated mascot, decorative emoji. Copy
follows pstack `unslop`: plain words, sentence case, no em dashes.
