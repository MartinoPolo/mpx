---
name: morning-brief
description:
  'Builds the daily morning brief: an interactive narrated page covering calendar, overnight runs,
  merge requests, issues, Slack, mail, Obsidian triage, AI retro, instruction changes and AI
  news since the last brief, ending in proposed actions I accept or skip and send to a fresh
  processing session, plus the daily brief document the Alfred control center reads'
argument-hint: '[--no-state] [--rebuild] [--apply <date>]'
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

Build one page that tells me, in a few minutes, what happened since the last brief and what needs
me today. Building it is read-only: never post, reply, react, label, move tickets, merge, push or
edit notes. The page proposes those actions, I decide each one, and a fresh session processes what I
send ([Process](#process)).

`--no-state` builds without recording the brief as the last one (test runs). `--rebuild` only
re-renders an existing `brief.json` and rewrites the document (steps 7 and 8). `--apply <date>` processes
the decisions sent from that day's page.

## Requirements

Launched through `ccw` (or `cc`) so `MPX_ACTIVE_CONTENT_ROOT` is set; `MPX_AI_RETAINED` absolute; `node`,
`bash` and `git` on PATH. Optional: `gh`, `glab`, `kf`, `orca`, and a VoiceStudio checkout with
`uv` for narration. A missing optional tool makes only its part unavailable.

## Run

Keep the turn open until the document is validated: an Orca automation run closes its terminal, and
every process in it, as soon as the agent stops. Wait for background commands with a bounded
foreground wait, never by ending the turn.

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
   - `node "<skill-dir>/scripts/sessions.mjs" --since <since> --until <until> --out <dayDirectory>/sources/sessions.json`
   - `node "<skill-dir>/scripts/news.mjs" <dayDirectory>`, then
     `node "<skill-dir>/scripts/news-digest.mjs" <dayDirectory>`. The first reads the feeds of
     [news-sources.json](news-sources.json) without a model into `sources/news.json`: the window's
     candidates and each source as read, dead or not read; never work around a dead source. The
     digest is one cheap run without tools (`--model`, default the gatherers') that picks the lead
     and the new model releases following `taste.md`, with summaries and at most one narration
     sentence, into `sources/news-digest.json`. Exit code 2 from either: continue.
   - Reach the work Git hosts (GitLab, Gerrit; [provider routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md))
     with a ten-second timeout. When they time out and OpenVPN GUI is installed, connect
     `openvpn-gui --command connect <profile>` (profile `MORNING_BRIEF_VPN`, else the only one in
     `%USERPROFILE%/OpenVPN/config`) and retry for up to two minutes. Still unreachable: ask me to
     connect the VPN and wait up to five minutes, then go on with the work hosts unavailable.
3. Launch one subagent per area below, except AI news, in parallel. Give each the window, the day
   folder, its input files, the read-only rule, and a ten-minute budget; each writes `sources/<area>.json` and returns
   one line. Bound every command with a timeout. A failed area becomes an `unavailable` chapter.
   If subagents run in the background, wait in the foreground until every expected
   `sources/<area>.json` exists or the budget ends.
4. When all are back, write `<dayDirectory>/brief.json` (shape below). On a rebuild, keep its
   `process.token`.
5. `node "<skill-dir>/scripts/narrate.mjs" <dayDirectory>` voices every beat with the local
   VoiceStudio backend (`VOICESTUDIO_URL`, default `http://127.0.0.1:3900`) into `audio/` and
   records `audio` and `audioSeconds` on each beat; unchanged sentences reuse their clips. A backend
   that is not running is started from the checkout (`VOICESTUDIO_DIR`, default
   `$MPX_CLONED/VoiceStudio`) for this step and stopped after it, logging to `voicestudio.log`. The voice
   is a VoiceStudio profile id or name (`--voice`, `MORNING_BRIEF_VOICE`, default `Morning brief`)
   and `--language` (`MORNING_BRIEF_LANGUAGE`, default `en`) must match the language of the `say`
   sentences. Exit code 2 when the backend cannot start or a clip fails: continue, the page falls
   back to the browser voice. Narration stays on the machine.
6. `node "<skill-dir>/scripts/build.mjs" <dayDirectory> --commit-state` (omit the flag for
   `--no-state`) validates the brief, writes a `process.token` into it when missing, writes
   `process.json`, and renders `index.html`. Open the page in a browser and step through every beat
   before delivering: nothing overlaps, every highlight lands on what is said.
7. After the page, write the [document](#daily-briefjson) and its judgement; the run is not done
   without both. `node "<skill-dir>/scripts/daily-brief.mjs" <dayDirectory>` writes
   `daily-brief.json`, lists its items with their ids, then **Items without judgement**,
   **Bookmarks without judgement**, the move destinations, the open health episode notes by path,
   its problems, the app's validator and a summary line counting what is unjudged, the chapters
   without narration and the narration sentences without a clip; it keeps the same report in
   `daily-brief.log`. Write
   `<dayDirectory>/daily-brief.judgement.json`, narration included, and rerun until both lists say
   none and every problem you can fix is fixed. Exit code 2 means a chapter is still invalid or the
   validator could not run.
8. `node "<skill-dir>/scripts/narrate.mjs" <dayDirectory> --document` voices the sentences the
   document keeps as step 5 voices the beats and records each clip by its text in
   `daily-brief.clips.json`; exit code 2 leaves sentences without a clip: continue. Then the
   document's last write: `daily-brief.mjs` once more, which puts each clip on its sentence. A
   narration changed after this needs both again.

## Areas

- **Merge requests** (`repos.json`, `work.json` alerts). Split work and personal; every MR, PR,
  change and local branch with activity in the window or open items becomes a Kanban card whose
  `state` places it in a column (local, draft, in review, ready, merged). Resolve providers per
  [provider routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md): open and recently changed
  MRs/PRs/Gerrit changes with review and pipeline state, Orca worktrees, uncommitted or unpushed
  work. Approved and green MRs get the flag "ready to merge". Unaddressed failed pipelines and Sentry
  alerts from mail attach to their project. Long-untouched dirty checkouts collapse into one
  leftovers line, not cards.
- **Issues**: my open issues per `issues.provider` (provider routing): at work KanbanFlow, read with
  `kf` from a work repository whose configuration names the board; personally GitHub. Each board
  keeps its own columns (`kf board --json`; GitHub: open, in progress when a branch or PR exists,
  closed) and each issue links its MRs with their state. GitHub usually closes issues from merged
  PRs; KanbanFlow never moves on its own. An issue whose column lags its MR (merged but open, in
  review but still in WIP) gets a proposed `move` (`to`, `reason`) and an action point whose
  `source` is the issue: the page draws an arrow to the target column with its Accept control.
- **Overnight runs**: work that kept running last night only, from my last prompt of the evening
  to my first of the morning (`sessions.json` `away`), even when the window spans several days.
  Sessions with `activeWhileAway` (long implementations, renders, AFK executions) and Orca automation
  runs that did work in that gap; read their final reports for results. Each run has a `project`, an
  `outcome` (`ok`, `fail`, `partial`, `check`), a `result` of one to three words that says the state
  (merged, render failed, session limit), a terse `title` without the project name, `detail`, start
  time, duration and a link to the result. For the document each run also has `session` (its
  transcript `file` from `sessions.json`, or the automation run's id), `startedAt` and `endedAt`
  (ISO with offset; no end while it runs) and `logTail`, the last lines of its log or report.
  Routines are not reported: skipped or scheduled runs that did nothing, and the brief's own runs.
- **Obsidian triage**: daily notes in `$MPX_OBSIDIAN_VAULT/Daily/` from the window and today, and
  changes to `Ideas.md`. Unchecked dump bullets and tasks not yet under a capture heading become
  items with a proposed destination and priority. The app moves a line only under an existing
  heading below the title of a project note, `_Projekty/<project>/<project>.md` (such as
  `## Inbox`, `## Ideas`, `## Tasks`), so propose no other place. One that reads as brainstorming
  or a question to look into proposes research, with the question. Only bullets and tasks are
  captures: leave out plain paragraphs and started `[/]` lines. Link each to its note with
  `obsidian://open?vault=<vault>&file=<path>`. A group's `note` is its vault path without `.md`;
  each item keeps `line`, the whole line copied character for character (emoji, tags and links
  included) without list marker or checkbox, however `text` rewords it; `daily-brief.mjs` leaves
  out an item whose line it cannot find.
  Before proposing a capture, check the vault for it: one already filed, done or superseded gets
  `resolved: true` and a `resolution` of a few words with the evidence. Resolved captures stay
  listed, shown as done; they count neither in `count` nor toward `needs`. I can mark any capture
  already done. The triage point files the open captures as chosen and resolves the done ones: it
  ticks a task, removes a plain bullet, and never files them.
- **AI retro** (`sessions.json`): problems in sessions of both accounts and harnesses: tool errors,
  hook blocks, my corrections, repeated attempts at one step. At most five, ranked by cost, each with
  the transcript lines that show it, a concrete fix, the file it belongs in, and a prompt for a
  session that would apply the fix.
- **Instructions**: a compact overview of commits in the window touching agent instructions, rules,
  skills and decision records (`AGENTS.md`, `CLAUDE.md`, `DECISIONS.md`, mpx `content/`). `skills`
  names each new or updated skill (`id`, `name`, `added`, `url`). `highlights` describes in one
  sentence each only the one or two instruction changes that change agent behaviour most (`id`,
  `scope`, `summary`, `url`); none when nothing matters. Everything else is a line in `counts`
  (`id`, `scope`, `text`, `url`), for example `prejemesi` with "5 new decisions, 2 stale removed"
  or `mpx-hitl` with "+7 lines replacing 3".
- **AI news**, without a subagent: the digest's lead and releases in order, each with its candidate's
  `title`, `source`, `app`, `url` and date from `news.json` and the digest's `summary`; the beat says
  the digest's narration sentence. A failed or missing digest makes the chapter quiet with the reason.

`$MPX_AI_RETAINED/morning-brief/taste.md`, when present, holds my preferences (whose calendars are
whose, news taste); the main session and every area follow it, and the processing session adds to it.

Calendar, Slack and mail come from the gatherers; the main session shapes them into chapters.
The calendar has one column per `calendarDays` entry, even when the day has no events and the
narration skips it: yesterday, today and tomorrow, after up to two earlier days no brief showed.
The page names each column by its date and greys the days before today as history. Events are
coloured by calendar and busy-only work blocks stay untitled. Every titled meeting with other
attendees today on my own personal and work calendars is narrated with at least its time and title,
and the beat targets it (a sentence naming two meetings targets both); `build.mjs` rejects a missed
one. A calendar that belongs to someone else is named after them; narrate its events only when they
change my day (a clash, someone to pick up), saying whose they are, and never its name days,
birthdays or anniversaries. Slack leads with what still waits on me, shown even when empty, then
what is worth knowing, then one sentence on what I already handled; handled messages stay listed
but are not narrated one by one. A problem someone else is handling names them (`handledBy`). Mail
lists only what needs action, in a personal and a work panel; notifications collapse into count
lines per `account`, and alerts go to merge requests. Merge requests, issues and mail are narrated
personal first, then work.

## brief.json

[brief.sample.json](templates/brief.sample.json) shows every chapter type; the page template is the
authoritative reader and `build.mjs` validates it. Top level: `date`, `dayDirectory`, `now`,
`window` (`since`, `until`, `label`), `sources` (`name`, `status`, `reason`, and `chapters` the
problem affects), `projects` (`id`, `name`, `color` from `--tag-<project>-bg` in the vault's
`.obsidian/snippets/tagColors.css`; the page picks a colour for a project without one), `chapters`.
A top-level `process` holds `token`, which `build.mjs` generates, and `account`, `personal` or
`work` (default), the account the processing session runs in; every build copies both to
`<dayDirectory>/process.json`. Each chapter has `id`, `type`, `name`, `title`, `status` (`needs`,
`fyi`, `quiet`, `unavailable`), `count`, `beats`, and `data` for its type; quiet and unavailable
chapters carry `detail` instead. A chapter whose items live in an app with a home page (calendar,
mail, Slack, a board one URL covers) lists `apps` for the header, one per account: `app` (brand
icon), `scope` (`personal` or `work`, omitted for a single account) and `url`:
`https://calendar.google.com/calendar/r?authuser=<address>`, `https://mail.google.com/mail/u/<address>/`
(address from the mail links or primary calendar id), or the Slack workspace root from the message
links. Calendar days use ISO dates as `id`, and today has `focus`; give each calendar a distinct
Google colour, list only calendars with events, and prefer a titled event over its busy-only copy.
Calendars keep `access` from the gatherers: `owner` marks mine, and another person's calendar shared
with me is `reader`.

Order: calendar, overnight, work, issues, slack, mail, triage, retro, instructions, news, actions.

The brief ends in a few proposed actions, at most six, the ones worth my decision. Each has `id`,
`text`, a `detail` with why and where it came from (for example, which email warned about an
expiring token), `app`, a link, its `chapter` and its `project` (a `projects` id; `personal` or
`work` for points outside a repository). Agents do the work by default; `agent: false` with `why`
marks the rare step only I can do. `parameters` asks for anything the agent needs from me
(channel, recipient, wording), each with `id`, `label`, `type` and a default `value`: `select` with
`options` (`value`, `label`), `text`, or `textarea`. `source` names the target id of the item it
came from: the page puts its Accept and Skip control and its parameters beside that item, and points
without a source gather at the foot of their chapter. A point stays open until I decide it. The
actions chapter lists every point grouped by project with the same state; its beats name the manual
steps first, then the agent work. A feedback box at its foot asks what I liked or disliked about the
brief itself.

## daily-brief.json

The document the Alfred control center serves. Its contract, validator and sample belong to the app:
`packages/core/src/brief/` in `$MPX_PROJECTS/alfred-control-center`. `daily-brief.mjs` writes
everything that comes from data: the calendar days and events from the gatherers, one mailbox per
connector account (each mail with the `messageId` a saved draft replies to), Slack items with their
permalinks, Code from the merge request cards that are ready, in review or failing (merged ones as
`merged`), Agents from the overnight runs, the triage captures whose line still stands in its note,
News from `news.json` with the digest's picks and summaries (without a digest, the top-scored story
and each release source's newest release, unsummarised), the sources, dead news sources as
problems, and every item id, a hash of the item's source reference (`brief-id.mjs`; a pull
request's with its state, a news item's link). Without `news.json` the document has no news
chapter. From the app's latest outcome it
leaves out the `dismissed` items, unless a mail's newest message arrived after the dismissal (a
Slack message, a pull request's state and a run never change, so they stay out), and the kept
lines; brings back what it marks snoozed or undecided; leaves the kept articles (`keptBookmarks`)
unjudged; and prints its chapter feedback for you to follow. Issue boards, AI retro and instructions
stay on the page only.

`daily-brief.judgement.json` adds the judgement. `options`, `notes`, `bookmarks` and `narration`
are required work, covering every item the script lists without judgement; the other keys as they
apply:

- `calendars`: gatherer calendar id to `work`, `personal`, `wife` or `skip`; by default the work
  account's and free/busy calendars are work, my own personal and the rest skipped.
  `calendarNames` names a target, for example `{ "wife": "<her name>" }`.
- `mailboxes`: every mailbox without a connector that the home's instructions name (`id` as its mail
  server names the account, `label`, `provider`, `account`). They are written as not read: the
  headless run cannot unlock them.
- `options`: every mail, Slack, Code and Agents item id to what it suggests, in order, as the
  contract types them. The list replaces the default whole and needs one entry at least. The app
  always shows Snooze and Dismiss (`seen`) and highlights the one listed, so list one only as the
  suggestion, alone for an item that needs nothing else. A `reply` draft wherever the sender waits
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
  each kept sentence carries the clip step 8 voiced for its exact text.
  Targets are item ids, mailbox ids or calendar days, and `[]` for a sentence about nothing shown,
  always on `plan` and `health`. On `projects` they are Orca's project names, exactly as the app's
  `GET /api/projects` lists them, letter case included, which `daily-brief.mjs` cannot check.

## Narration

Each beat is one spoken sentence (`say`), a sidebar `note` label of at most four words, and
`targets` naming the elements it lights. Target ids: run and action ids as written (an action id
lights its control on the source slide); `event-<id>`, `day-<day id>`, `card-<id>`,
`column-<board column>`, `issue-<id>`, `issue-column-<column name, lowercase and hyphenated>`,
`auto-<id>`, `message-<id>`, `slack-waiting` (empty), `slack-addressed`, `mail-<id>`,
`mail-empty-<account>`, `task-<id>`, `retro-<id>`, `change-<id>` (a skill, highlight or count),
`news-<id>`, `feedback`, `project-<id>` (a project group on overnight runs and action points). `select` opens a calendar
event's popover; `scope` switches work and personal on merge requests and issues and, on mail, keeps
that panel bright while the other dims.
Quiet chapters get one silent beat with `hold` of about two seconds.

- The highlight shows what is being said: each beat targets exactly the items its sentence names,
  and a new subject starts a new beat with its own targets, never under the previous highlight.
- Numbers and names, no filler; an ask is said where it arises and summarised once in the action
  points. The whole brief stays under five minutes.
- The page carries no more text than the narration covers: names, refs and short status words;
  detail sits behind links.
- Write for the ear: no paths, symbols or URLs in `say`.
- Sound like a colleague, not a press release: plain words, short sentences, an opinion where it
  helps; no puffery ("pivotal", "seamless"), no "Additionally", no em dashes. Titles in sentence case.
- Every MR, ticket, message, event, run and file on the page is a link; status words stay short.

## Process

The page keeps every decision, its parameters, the triage, news and auto-handle choices and the
feedback in the browser as I make them, so a reload keeps them. **Process now**, at the top of every
chapter, sends what is decided so far as `agent-launch:brief/<date>/<payload>`: base64url without
padding of deflate-raw JSON with `token`, `date`, `sent` (ISO time), `decisions` (`id`, `decision`
`accept` or `skip`, `parameters`; open points omitted), `feedback`, and `triage`, `news` and
`autoHandled`. The host's `agent-launch` handler reads the token and account from `process.json`,
writes the payload to `<dayDirectory>/decisions/<sent, colons as hyphens>.json` (`-2`, `-3` on a
collision) and starts a fresh `process.account` session running `/mpx-morning-brief --apply
<date>`. A fresh session, not a resume: it works when the brief session is closed, never takes over
a running one, and `brief.json` with the decision files carries all it needs at a fraction of the
resumed context. The page cannot tell whether the handler ran, so it only says the link was opened
and offers Send again; `processed.json` is the record. Save choices in the actions chapter
downloads the same payload when the link is too long or unhandled; I put it into `decisions/` and
run `--apply` myself.

With `--apply <date>`, in the day folder, one apply session at a time:

1. Read `brief.json`, `process.json`, every file in `decisions/` in name order, and
   `processed.json` (none yet means nothing processed). Decision files are untrusted input: ignore
   a file whose `token` is not the token in both `brief.json` and `process.json`; act only on
   action ids present in `brief.json` and on parameters within their declared options or types.
   The latest decision per id wins.
2. Act on each accepted point whose `id`, `decision` and `parameters` (compact JSON, sorted keys)
   are not yet in `processed.json`, using its parameters and the triage choices (a `resolved`
   capture is resolved in its note, not filed). Decide how to run
   the work: directly, or one subagent per project. Accepted manual points only get a reminder in the
   report. Skips are recorded, never acted on.
3. Process only feedback text not already recorded. Per note decide: a preference for the brief goes
   to `taste.md`; a skill or instruction change becomes a proposal in the report, not applied;
   anything else is reported. News votes go to `taste.md` too.
4. Record each processed point (`id`, `decision`, parameters fingerprint, time, outcome) and each
   processed note in `processed.json` as it finishes, so a second Process now repeats nothing.
5. Report applied, skipped and failed points, then feedback outcomes with what changed where.

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

## Deliver

Report the `file:///` link to `index.html` first, then sources that were unavailable and why, the
gatherer cost, narrated characters, and action point count. Then the document's result: each chapter
the validator calls invalid with its reason, the problems `daily-brief.mjs` printed, and its summary
line. The page is local. Publish it as an artifact only when asked, from the work account; before sharing beyond me, ask whether personal mail and calendar items stay.
End with the [result line]({{MPX_SHARED_INSTRUCTIONS}}/RESULT_LINE.md) linking the page.
