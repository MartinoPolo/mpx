---
name: morning-brief
description:
  'Builds the daily brief document the Alfred control center shows: calendar, mail, Slack, merge
  requests, overnight runs, Obsidian captures and AI news since the last brief, each item with a
  judged suggestion and the chapters with voiced narration'
argument-hint: '[--no-state] [--rebuild]'
triggers:
  morning brief; morning summary; daily brief
metadata:
  author: MartinoPolo
  version: '0.1'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Morning brief

Build the daily brief document that tells me, in a few minutes, what happened since the last brief
and what needs me today. Building it is read-only: never post, reply, react, label, move tickets,
merge, push or edit notes. The document suggests those actions; I decide each in the Alfred control
center, which carries them out ([Connector run](#connector-run) for the connector writes).

`--no-state` builds without recording the brief as the last one (test runs): pass it to every
`daily-brief.mjs` call. `--rebuild` rewrites the document of today's existing day folder: steps 5 to
7 on its sources and `brief.json`.

## Requirements

Launched through `ccw` (or `cc`) so `MPX_ACTIVE_CONTENT_ROOT` is set; `MPX_AI_RETAINED` absolute; `node`,
`bash` and `git` on PATH. Optional: `gh`, `glab`, `orca`, and a VoiceStudio checkout with `uv` for
narration. A missing optional tool makes only its part unavailable.

## Run

Keep the turn open until step 7 is done: an Orca automation run closes its terminal, and every
process in it, as soon as the agent stops. Wait for background commands with a bounded foreground
wait, never by ending the turn.

1. `node "<skill-dir>/scripts/start.mjs"` prints `date`, `dayDirectory`, `since`, `until` and
   `calendarDays`, and keeps them in `<dayDirectory>/start.json` for the later scripts. All files of
   this run go into `dayDirectory`; source files go into its `sources/`.
2. Start these together, the first in the background:
   - `node "<skill-dir>/scripts/gather.mjs" <dayDirectory> --since <since> --until <until>` runs
     one headless connector session per account ([personal](gatherers/personal.md): Gmail and
     Calendar; [work](gatherers/work.md): Slack, Gmail, and Calendar once connected) and writes
     `sources/personal.json` and `sources/work.json`, each `ok` with `data` or `unavailable` with
     `reason`. `--only personal|work` reruns one.
   - `node "<skill-dir>/scripts/repos.mjs" --since <since> --out <dayDirectory>/sources/repos.json`
     lists every repository folder under the roots with its `remote` (`forge`, `host`, `fullName`,
     `web`) and `active`: a commit in the last month or an open task in its vault project note, as the
     control center's Projects page decides. One with local activity in the window carries its Git
     state.
   - `node "<skill-dir>/scripts/sessions.mjs" --since <since> --until <until> --out <dayDirectory>/sources/sessions.json`
   - `node "<skill-dir>/scripts/news.mjs" <dayDirectory>`, then
     `node "<skill-dir>/scripts/news-digest.mjs" <dayDirectory>`. The first reads the feeds of
     [news-sources.json](news-sources.json) without a model into `sources/news.json`: the window's
     candidates and each source as read, dead or not read; never work around a dead source. The
     digest is one run of the cheapest tier without tools (`--model`, default `haiku`) that picks the
     lead and the new model releases following `taste.md`, with summaries and at most one narration
     sentence, into `sources/news-digest.json`. Exit code 2 from either: continue.
   - Reach the work Git hosts (GitLab, Gerrit; [provider routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md))
     with a ten-second timeout. When they time out and OpenVPN GUI is installed, connect
     `openvpn-gui --command connect <profile>` (profile `MORNING_BRIEF_VPN`, else the only one in
     `%USERPROFILE%/OpenVPN/config`) and retry for up to two minutes. Still unreachable: ask me to
     connect the VPN and wait up to five minutes, then go on with the work hosts unavailable.
3. Launch one subagent per [area](#areas), in parallel. Give each the window, the day folder, its
   input files, the read-only rule, and a ten-minute budget; each writes `sources/<area>.json` and
   returns one line. Bound every command with a timeout. If subagents run in the background, wait in
   the foreground until every expected `sources/<area>.json` exists or the budget ends.
4. When all are back, write `<dayDirectory>/brief.json` ([below](#briefjson)); a failed area is
   written as unavailable.
5. `node "<skill-dir>/scripts/daily-brief.mjs" <dayDirectory>` writes the
   [document](#daily-briefjson) `daily-brief.json` and, unless `--no-state`, records the brief in
   `state.json` as the last one, so the next window starts where this one ended. It lists the items
   with their ids, then **Items without judgement** with each item's default, **Bookmarks without
   judgement**, the move destinations, the open health episode notes by path, its problems, the app's
   validator and a summary line: what is unjudged, the narration sentences without a clip, whether
   the document is valid, then the chapters without narration (information: none is right where
   nothing is worth saying). It keeps the same report in `daily-brief.log`. Write
   `<dayDirectory>/daily-brief.judgement.json`, narration included, and rerun until the summary
   counts `0 items and 0 bookmarks without judgement`, the document is valid, and every problem you
   can fix is fixed. Exit code 2 means a chapter is still invalid or the validator could not run.
6. `node "<skill-dir>/scripts/narrate.mjs" <dayDirectory>` voices the narration sentences the
   document keeps with the local VoiceStudio backend (`VOICESTUDIO_URL`, default
   `http://127.0.0.1:3900`) into `audio/`, records each clip by its text in `daily-brief.clips.json`
   and keeps its result line in `narrate.log`; unchanged sentences reuse their clips. A backend that
   is not running is started from the checkout (`VOICESTUDIO_DIR`, default `$MPX_CLONED/VoiceStudio`)
   for this step and stopped after it, logging to `voicestudio.log`. The voice is a VoiceStudio
   profile id or name (`--voice`, `MORNING_BRIEF_VOICE`, default `Morning brief`) and `--language`
   (`MORNING_BRIEF_LANGUAGE`, default `en`) must match the language of the sentences. Exit code 2
   when the backend cannot start or a clip fails: continue. Narration stays on the machine.
7. The document's last write: `daily-brief.mjs` once more, which puts each clip on its sentence. The
   run is done when its summary reads `0 items and 0 bookmarks without judgement; 0 narration
   sentences without a clip; the document is valid.` Only a voicing failure of step 6 may leave
   sentences without a clip; report it. A narration changed after this needs steps 6 and 7 again.

## Areas

- **Merge requests** (`repos.json`, `work.json` alerts). Query only the repositories `repos.json`
  lists as `active`, each by its `remote` (for example `gh pr list --repo <fullName>`), and the open
  changes in any repository that request my review, marked `reviewRequested`. Never search all of an
  owner's or group's changes. Resolve each provider, Gerrit included, per
  [provider routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md). Every MR, PR, Gerrit change
  and local branch of those with activity in the window or open items, work and personal, becomes a
  card whose `state` says where it stands: open and recently changed changes with review and pipeline
  state, Orca worktrees, uncommitted or unpushed work. Approved and green MRs are `ready`; an
  unaddressed failed pipeline makes its MR `failing`. Long-untouched dirty checkouts are no cards.
- **Overnight runs**: work that kept running last night only, from my last prompt of the evening
  to my first of the morning (`sessions.json` `away`), even when the window spans several days.
  Sessions with `activeWhileAway` (long implementations, renders, AFK executions) and Orca automation
  runs that did work in that gap; read their final reports for results. Routines are not reported:
  skipped or scheduled runs that did nothing, and the brief's own runs.
- **Obsidian triage**: daily notes in `$MPX_OBSIDIAN_VAULT/Daily/` from the window and today, and
  changes to `Ideas.md`. Unchecked dump bullets and tasks not yet under a capture heading are
  captures; only bullets and tasks: leave out plain paragraphs and started `[/]` lines. Each keeps
  its whole `line`, copied character for character (emoji, tags and links included) without list
  marker or checkbox; `daily-brief.mjs` leaves out a capture whose line it cannot find. Before
  listing a capture, check the vault for it: one already filed, done or superseded gets
  `resolved: true` and a `resolution` of a few words with the evidence.

`$MPX_AI_RETAINED/morning-brief/taste.md`, when present, holds my preferences (whose calendars are
whose, news taste); the main session, every area and the news digest follow it.

## brief.json

The session's data file for Code, Agents and the capture lines; [brief.sample.json](brief.sample.json)
shows its shape. `projects` lists `id` and `name` of the projects the runs name. `chapters` holds
one entry per area, its `type` `work`, `overnight` or `triage` and its `data`; an area that failed
has `status: "unavailable"` and its reason as `detail` instead, which the document lists as a source
not read.

- `work`: `data.projects`, each with `id`, `name`, `app` (`github` or `gitlab`; the document leaves
  out other forges with a problem) and `cards`: `ref`, `title`, `state` (`local`, `draft`, `review`,
  `ready`, `failing`, `merged`), `url` (the change's web address), `reviewRequested: true` on a
  change that requests my review, `author` of a review, and `pipeline` (`status` `success`, `failed`
  or `running`, and the failed `job`). The document shows the ready, review, failing and merged
  cards whose `url` host and path name an active repository of `repos.json`, or that request my
  review; it names each card it leaves out.
- `overnight`: `data.runs`, each with `project` (a `projects` id), `outcome` (`ok`, `fail`,
  `partial`, `check`), a terse `title` without the project name, `session` (its transcript `file`
  from `sessions.json`, or the automation run's id), `url` of the result, `startedAt` and `endedAt`
  (ISO with offset; no end while it runs) and `logTail`, the last lines of its log or report. A run
  without `startedAt` is left out.
- `triage`: `data.groups`, each with `note`, the vault path of the note, and `items`: `line`, and
  `resolved` with `resolution` for a capture already done.

## daily-brief.json

The document the Alfred control center serves. Its contract, validator and sample belong to the app:
`packages/core/src/brief/` in `$MPX_PROJECTS/alfred-control-center`. `daily-brief.mjs` writes
everything that comes from data: the calendar days and events from the gatherers, one mailbox per
connector account (each mail with the `messageId` a saved draft replies to), Slack items with their
permalinks, Code from the merge request cards, Agents from the overnight runs, the triage captures
whose line still stands in its note, News from `news.json` with the digest's picks and summaries
(without a digest, the top-scored story and each release source's newest release, unsummarised), the
sources, dead news sources as problems, and every item id, a hash of the item's source reference
(`brief-id.mjs`; a pull request's with its state, a news item's link). Without `news.json` the
document has no news chapter. From the app's latest outcome it leaves out the `dismissed` items,
unless a mail's newest message arrived after the dismissal (a Slack message, a pull request's state
and a run never change, so they stay out), and the kept lines; brings back what it marks snoozed or
undecided; leaves the kept articles (`keptBookmarks`) unjudged; and prints its chapter feedback for
you to follow.

`daily-brief.judgement.json` adds the judgement. `options`, `notes`, `bookmarks` and `narration`
are required work, covering every item the script lists without judgement; the other keys as they
apply:

- `calendars`: gatherer calendar id to `work`, `personal`, `wife` or `skip`; by default the work
  account's and free/busy calendars are work, my own personal and the rest skipped.
  `calendarNames` names a target, for example `{ "wife": "<her name>" }`.
- `mailboxes`: every mailbox without a connector that the home's instructions name (`id` as its mail
  server names the account, `label`, `provider`, `account` its address). They are written as not
  read yet: their passwords need my Windows Hello approval, so they are read when I press Start in
  the brief at the desk ([Start run](#start-run)).
- `options`: every mail, Slack, Code and Agents item id to what it suggests, in order, as the
  contract types them. The list replaces the default whole and needs one entry at least; `"default"`
  instead of a list, or of a capture's suggestion in `notes`, accepts the default the script prints
  beside the item. The app always shows Snooze and Dismiss (`seen`) and highlights the one listed, so
  a list with a reply, event, task or action never ends with them; list one only when it is the
  suggestion itself, alone. A pull request whose state changed gets a new id, so a rebuild drops the
  judgement written for its old id, which the script reports. A `reply` draft wherever the sender waits
  for an answer, in my voice and the thread's language (`subject` for mail, `where` for Slack); an
  `event` or `task` where the message asks for one; on Code and Agents an `action` (`label`,
  `icon` from the app's `ACTION_ICONS` in
  `packages/ui/src/lib/components/blocks/decision-item/decision-group-icons.ts`, `execution`):
  `merge`, `rerun`, `reminder` (a Plan row for me), or `session` (a new Orca session in
  `projectName` running `prompt`). A mail reply's `to` names its recipients, or is left out for
  the sender; `daily-brief.mjs` writes each as `Name <address>` from the gathered message and
  reports a name it cannot address, which the app refuses until I add one. A Slack reply's `to`
  and `where` are only shown: it goes to the permalink's thread. An unjudged item keeps a default:
  a mail ask snoozed, other messages and runs dismissed, a card Merge, Rerun or Review today.
  Judge and narrate only what was read: a thread the gatherer could not read in full is said to be
  not read in full, never filled in.
- `notes`: every capture id to its suggestion: `move` with `destination` (`notePath`, `heading`:
  one of the move destinations the script lists), `priority` (1 to 5) and optional new `wording`;
  `research` with the question as `wording`, for a line that reads as brainstorming or a question;
  `done`, `progress` (with the `link` of the issue or pull request that tracks it), `delete` or
  `keep`. Only a move carries `destination` and `priority`, and only a move or research `wording`;
  any may say `because`. The app refuses to move or delete a line with lines nested under it and to
  tick a plain bullet; the script marks both, and refused suggestions are problems. An unjudged
  capture is kept, or done when resolved (deleted when a plain bullet).
- `bookmarks`: every `capture.json` bookmark id to its `kind`, `suggestion` and `csfd`;
  `wishlists` lists the wishlists a shop find can move to.
- `quietRuns`: automations that ran fine and sessions closed in the window.
- `reminders`: Plan reminders, the home's additions such as deadlines and the monthly invoice.
- `hints`: one per open health episode note the script lists, `conditionId` its path and `text`
  one short practical hint. Read each listed note yourself, without a subagent: what to try or watch
  given its check-ins, no diagnosis, and to see a doctor when it worsens over several days. Never
  quote a note. A hint for any other path is a problem and left out.
- `narration`: per document chapter (`calendar`, `mail`, `slack`, `code`, `agents`, `capture`,
  `projects`, `plan`, `health`) an overview of at most two short sentences (`text`, `targets`)
  saying what matters, such as the event that shapes the day or how many messages wait;
  none where nothing is worth saying. `news` speaks the digest's sentence unless you write one.
  `daily-brief.mjs` keeps the first two and reports the rest;
  each kept sentence carries the clip step 6 voiced for its exact text.
  Targets are item ids, mailbox ids or calendar days, and `[]` for a sentence about nothing shown,
  always on `plan` and `health`. On `projects` they are Orca's project names, exactly as the app's
  `GET /api/projects` lists them, letter case included, which `daily-brief.mjs` cannot check.

## Narration

- Numbers and names, no filler. Write for the ear: no paths, symbols or URLs.
- Sound like a colleague, not a press release: plain words, short sentences, an opinion where it
  helps; no puffery ("pivotal", "seamless"), no "Additionally", no em dashes.
- A calendar that belongs to someone else is named after them; mention its events only when they
  change my day (a clash, someone to pick up), and never its name days, birthdays or anniversaries.

## Connector run

The Alfred control center's Process sends mail, saves drafts, creates events and posts to Slack
through `node "<skill-dir>/scripts/apply.mjs" <run directory>`, never through this skill's session.
`run.json` there holds `day`, an optional `model` (default the gatherers' cheap model) and
`operations`: `id`, `account` (`personal` or `work`), `kind` (`gmail-send`, `gmail-draft`,
`calendar-event`, `slack-send`, `slack-draft`) and `arguments`, exactly the tool's input. One
headless session per account runs from `$MPX_AI_RETAINED/morning-brief/<day>`, allowed only the
tools its operations need. [apply-hook.mjs](scripts/apply-hook.mjs) denies every call whose input
differs from an approved one in a single character, or repeats one, and records each answer in
`answers/<id>.json` as it arrives. `result.json` gives each operation `done` with its link, `failed`
with a reason, or `unknown` when a call started and its answer never came. Exit code 2 unless every
operation is done.

## Start run

Pressing Start in the brief at the desk reads the IMAP mailboxes through
`node "<skill-dir>/scripts/mailboxes.mjs" <run directory>`, never through this skill's session.
`run.json` there names the window, the `model`, Alfred's `mailCommand`, the `partsDirectory`, the
mailboxes and the dismissed items. One mailbox at a time, so only one Windows Hello prompt shows,
the mail command reads the window's inbox; then one run without tools sorts its threads following
[mailboxes.md](gatherers/mailboxes.md), as mail text is untrusted. Each mailbox read becomes
`parts/mail-<id>.json` beside the document, a whole Mail mailbox that replaces the document's.
`result.json` gives each mailbox `read`, or `failed` with a reason I can act on. Exit code 2 unless
every mailbox was read.

## Deliver

Report the sources that were unavailable and why, the gatherer and digest cost, and `narrate.log`'s
result line. Then the document's result: each chapter the validator calls invalid with its reason,
the problems `daily-brief.mjs` printed, and its last summary line. End with the
[result line]({{MPX_SHARED_INSTRUCTIONS}}/RESULT_LINE.md) linking `daily-brief.json`.
