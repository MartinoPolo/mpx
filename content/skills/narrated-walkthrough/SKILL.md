---
name: narrated-walkthrough
description:
  'Builds a narrated, interactive code walkthrough of a change (MR, branch, or commit range): voiced
  chapters that steer a Monaco diff, with a recorded before-and-after demo when the change is visible;
  appends update chapters when the change moves on'
argument-hint: '<change: PR, branch, or base..head> [--mode artifact|local] [--follow-up] [--autonomous]'
triggers:
  narrated code walkthrough; voiced MR walkthrough; code review video
metadata:
  author: MartinoPolo
  version: '0.5'
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

`--autonomous` runs without the user: make every choice the steps below would ask about yourself,
including the chapter plan, and stop with ❌ instead of asking when something blocks, such as a
missing requirement or an exhausted TTS quota.

## Engine

`node "<skill-dir>/scripts/setup.mjs"` installs the engine once and prints its path, `<engine>`. Work
in a run folder `<MPX_AI_DUMP>/_WALKTHROUGHS/<project>.<slug>/` and call the tools from there:

- `node <engine>/tools/demo-record.mjs [--round=<n>]`: visible changes only; records the round's
  demo from its recipe into `cache/demo/`, or `cache/demo-<n>/` for an update.
- `node <engine>/tools/capture.mjs [--round=<n>] [name...]`: runs the round's capture script
  against its sides' builds and writes screenshots, recordings, real DevTools panels and stacked
  compositions to `cache/media/`, each a media name for `scene.media`.
- `node <engine>/tools/narrate.mjs`: synthesises sentences that have no clip yet and writes
  `timeline.json`. It prints each clip's words per second; an outlier usually means a misread
  identifier or a bad split.
- `node <engine>/tools/build.mjs`: writes `page/` from `script.json` and `timeline.json`.

Start from [script.json](templates/script.json). A visible change adds the demo block and chapter
from [script-demo.json](templates/recipe/script-demo.json) and a `recipe/` folder from
[frame.html](templates/recipe/frame.html) and [recipe.mjs](templates/recipe/recipe.mjs); media start
from [capture.mjs](templates/capture/capture.mjs). An earlier run's recipe or capture for the same
repository is a better start. The tools are the authoritative readers of these files.

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
- Put a visual beside the code whenever the narration talks about something that can be seen: a
  screenshot, a recording, or the page in a real app. Code stays on the left, the visual on the
  right; three columns only when two files and a visual are all needed at once. When the change
  alters DOM structure, show the real DevTools Elements panel around the element, before and after.
- Capture only from local or development environments that hold no real user data, and never show
  credentials, tokens or personal data in a capture.
- An alternatives card only when more than one reasonable fix existed. It is a record, not a vote:
  the chosen fix, ones the author weighed (PR description, commits, linked issue), and your own
  ideas marked `suggestion`, also said aloud, each with pros and cons. An approach that does not
  solve the problem is `rejected` with a `why`, included only when its failure explains the
  design; title the card for what it holds, such as "Why not simpler?" when nothing else fixes it.
- End with a `reproduce` card: every step you took to see or capture the change, complete enough
  for the reader to repeat, with local URLs because the change may not be deployed. Steps that need
  heavier infrastructure (Docker, VPN, other repositories) go in `collapsed` sections. Never write
  credential values.
- When the change is about the keyboard, press keys through the recipe's `press`, never
  `page.keyboard`, so each one shows as a keycap. Press them where they prove the point, such as one
  Tab into a group whose first item is disabled, with a readout of what received focus.
- Visual chapters run on with short gaps; code beats leave time to read.
- Every claim must be true of the diff. Demo verdicts come from what the recipe observed.

## Follow-up

When the run folder already holds a walkthrough of this change and the change's head has moved past
its last round, append an update rather than rebuilding: `--follow-up` and `--autonomous` choose it,
otherwise ask, recommending the update. Earlier chapters, their clips and media stay exactly as
they were; they describe the state they covered.

- Add an entry to `review.updates` and its scenes from
  [script-update.json](templates/script-update.json). Each update scene carries `"round"`, its
  index in the rounds, and comes after every earlier scene. Its code shows the diff from the
  previous round's head to the update's head.
- Open with an overview card of what changed since the previous round and what earlier chapters
  still describe that this update replaces, so nothing is narrated twice. End with the update's
  own reproduce card. The page opens at the latest update.
- Demo and capture sides name the state they run: `base` before the work, `reviewed` where the
  update starts, `head` now. Add `reviewed` as a middle column only when it behaves differently
  from both others; when the update changes no runtime code, say that `reviewed` behaves like now.
- After a rebase the previous head is no longer an ancestor of the new one, and a plain diff would
  narrate upstream commits. Rebase the reviewed commits onto the new base in a temporary branch and
  give that commit as the update's `base`.

## Not obvious

- `say` is spoken: write identifiers the way developers say them (`clipboard dot ts`, a `ys-`
  prefix as `why-ess`) and keep symbols and paths out.
- A highlight's `at` is a phrase from `say`; its time is estimated from its position in the sentence.
- `lines` marks rows like `12-16`, or `o23-o25` for removed lines; `token.text` must occur on its
  row; `then.at` is seconds into the beat; `link` keeps the previous mark as a ghost.
- Demo clips are `<scene>` and `<scene>-<side>`, such as `main-before`; `data-region` elements in
  the frame become highlight targets `<side>.<name>`. While one side acts the others are inert, so a
  key that moves focus out of its page never reaches another side.
- Media regions become targets `<media>.<region>`; a composition prefixes them with each part's
  `key`, as in `dom.after.hidden`. `devtools().reveal` takes `rowsAbove` to keep context above the
  selected row; a lower `treeHeight` keeps unrelated nodes (fingerprint blobs, debug toolbars) out.
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
say so. A private artifact counts as delivery to the user, not wider sharing; never share its link
beyond them unless asked.

Report the link first, then chapter and beat count, whether a demo was recorded, the media captured,
TTS requests spent, and what needs a human: listening for mispronounced identifiers, checking that
suggested and rejected alternatives are fair, and that the reproduce steps work on their machine.
