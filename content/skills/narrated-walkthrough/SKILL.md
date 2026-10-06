---
name: narrated-walkthrough
description:
  'Builds a narrated, interactive code walkthrough of a change (MR, branch, or commit range): voiced
  chapters that steer a Monaco diff, with a recorded before-and-after demo when the change is visible'
argument-hint: '<change: PR, branch, or base..head> [--mode artifact|local]'
triggers:
  narrated code walkthrough; voiced MR walkthrough; code review video
metadata:
  author: MartinoPolo
  version: '0.2'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Narrated code walkthrough

Explain one change to a reviewer who has not seen it, as a page: a chapter list, cards, and Monaco
panes over the real diff, driven by one narrated clip per beat. You decide what to explore, what to
say and how to structure it; the engine only renders what `script.json` describes.

## Requirements

`node`, `git`, and `ffmpeg` with `ffprobe` on PATH. `GEMINI_API_KEY` or another TTS provider.
`MPX_TEMP` (the shared engine install) and `MPX_AI_DUMP` (run folders) must be set and absolute; if
either is unset or problematic, ask the user where to work and generate.

## Engine

`node "<skill-dir>/scripts/setup.mjs"` installs the engine once and prints its path, `<engine>`. Work
in a run folder `<MPX_AI_DUMP>/_WALKTHROUGHS/<project>.<slug>/` and call the tools from there:

- `node <engine>/tools/demo-record.mjs`: visible changes only; records `cache/demo/` from the recipe.
- `node <engine>/tools/narrate.mjs`: synthesises sentences that have no clip yet and writes
  `timeline.json`. It prints each clip's words per second; an outlier usually means a misread
  identifier or a bad split.
- `node <engine>/tools/build.mjs`: writes `page/` from `script.json` and `timeline.json`.

Start from [script.json](templates/script.json). A visible change adds the demo block and chapter
from [script-demo.json](templates/recipe/script-demo.json) and a `recipe/` folder from
[frame.html](templates/recipe/frame.html) and [recipe.mjs](templates/recipe/recipe.mjs); an earlier
run's recipe for the same repository is a better start. The tools are the authoritative readers of
these files.

## Content

- Show before you explain. When the change has any visible effect, the walkthrough opens with an
  overview, then a before-and-after demo, then the code, because seeing the difference is the
  easiest way in. The demo records the recipe running both revisions' real builds side by side:
  hold a state still for a screenshot-like comparison, or script an interaction or animation when
  the change is about behaviour, whichever shows the difference fastest. Changes nobody can see
  (backend, refactor, tooling) start straight with the code.
- The code is the subject. Order it by meaning, never by file or diff position, the way you would
  explain it to a colleague at your desk: first the core of the change, the few lines that are the
  actual fix, then outward to what it relies on and what relies on it (the functions it calls, the
  properties and types it reads, the callers that reach it), and last the supporting edits such as
  tests, stories and config. Each chapter builds on the ones before it; jump between files whenever
  the explanation does.
- An alternatives card only when more than one reasonable fix existed. It is a record, not a vote:
  the chosen fix, ones the author weighed (PR description, commits, linked issue), and your own
  ideas marked `suggestion`, also said aloud.
- Visual chapters run on with short gaps; code beats leave time to read.
- Every claim must be true of the diff. Demo verdicts come from what the recipe observed.

## Not obvious

- `say` is spoken: write identifiers the way developers say them (`clipboard dot ts`, a `ys-`
  prefix as `why-ess`) and keep symbols and paths out.
- A highlight's `at` is a phrase from `say`; its time is estimated from its position in the sentence.
- `lines` marks rows like `12-16`, or `o23-o25` for removed lines; `token.text` must occur on its
  row; `then.at` is seconds into the beat; `link` keeps the previous mark as a ghost.
- Demo clips are `<scene>`, `<scene>-before` and `<scene>-after`; `data-region` elements in the
  frame become highlight targets `before.<name>` and `after.<name>`.
- The frame fakes every system resource the component touches (clipboard, network, storage), so a
  demo never writes to the machine or reaches real services. Revision builds run with Sentry
  variables blanked; add other telemetry keys to `demo.environment`.
- Clips are cached by sentence, voice and style: an edited sentence costs one request, a new voice
  or style re-synthesises everything. Free-tier TTS allows few requests per day, so agree the
  chapter plan with the user before narrating. Another provider replaces `speak` in
  `tools/gemini-tts.mjs`.

## Deliver

Look at the built page in a browser first. Default to an artifact when the runtime can publish
one, a `file:///` link to `page/index.html` otherwise; honor `--mode`. An artifact is
`page/index.html` with the rest of `page/` as its files. The page contains the repository's code:
say so, and never share it more widely than the user asks.

Report the link first, then chapter and beat count, whether a demo was recorded, TTS requests spent,
and what needs a human: listening for mispronounced identifiers and checking that suggested
alternatives are fair.
