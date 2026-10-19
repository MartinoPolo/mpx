---
name: morning-brief
description:
  'Builds the daily morning brief: an interactive narrated page covering calendar, overnight runs,
  merge requests, issues, Slack, mail, Obsidian triage, AI retro, instruction changes and AI
  news since the last brief, with action points approved where they arise and saved for a separate
  apply session'
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

Build one page that tells me, in a few minutes, what happened since the last brief and what needs
me today. Everything here is read-only: never post, reply, react, label, move tickets, merge, push or
edit notes. The page proposes those actions, I decide each one, and a separate session applies the
saved choices.

`--no-state` builds without recording the brief as the last one (test runs). `--rebuild` only
re-renders an existing `brief.json`.

## Requirements

Launched through `ccw` (or `cc`) so `MPX_ACTIVE_CONTENT_ROOT` is set; `MPX_AI_DUMP` absolute; `node`,
`bash` and `git` on PATH. Optional: `gh`, `glab`, `kf`, `orca`, and a VoiceStudio checkout with
`uv` for narration. A missing optional tool makes only its part unavailable.

## Run

Keep the turn open until the page is built: an Orca automation run closes its terminal, and every
process in it, as soon as the agent stops. Wait for background commands with a bounded foreground
wait, never by ending the turn.

1. `node "<skill-dir>/scripts/start.mjs"` prints `date`, `dayDirectory`, `since` and `until`. All
   files of this run go into `dayDirectory`; source files go into its `sources/`.
2. Start these together, the first in the background:
   - `node "<skill-dir>/scripts/gather.mjs" <dayDirectory> --since <since> --until <until>` runs
     one headless connector session per account ([personal](gatherers/personal.md): Gmail and
     Calendar; [work](gatherers/work.md): Slack, Gmail, and Calendar once connected) and writes
     `sources/personal.json` and `sources/work.json`, each `ok` with `data` or `unavailable` with
     `reason`. `--only personal|work` reruns one.
   - `node "<skill-dir>/scripts/repos.mjs" --since <since> --out <dayDirectory>/sources/repos.json`
   - `node "<skill-dir>/scripts/sessions.mjs" --since <since> --until <until> --out <dayDirectory>/sources/sessions.json`
   - Reach the work Git hosts (GitLab, Gerrit; [provider routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md))
     with a ten-second timeout. When they time out and OpenVPN GUI is installed, connect
     `openvpn-gui --command connect <profile>` (profile `MORNING_BRIEF_VPN`, else the only one in
     `%USERPROFILE%/OpenVPN/config`) and retry for up to two minutes. Still unreachable: ask me to
     connect the VPN and wait up to five minutes, then go on with the work hosts unavailable.
3. Launch one subagent per area below in parallel. Give each the window, the day folder, its input
   files, the read-only rule, and a ten-minute budget; each writes `sources/<area>.json` and returns
   one line. Bound every command with a timeout. A failed area becomes an `unavailable` chapter.
   If subagents run in the background, wait in the foreground until every expected
   `sources/<area>.json` exists or the budget ends.
4. When all are back, write `<dayDirectory>/brief.json` (shape below).
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
   `--no-state`) validates the brief and renders `index.html`. Open the page in a browser and step
   through every beat before delivering: nothing overlaps, every highlight lands on what is said.

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
  `source` is the issue: the page draws an arrow to the target column with its Approve control.
- **Overnight runs**: work that kept running last night only, from my last prompt of the evening
  to my first of the morning (`sessions.json` `away`), even when the window spans several days.
  Sessions with `activeWhileAway` (long implementations, renders, AFK executions) and Orca automation
  runs that did work in that gap; read their final reports for results. Each run has a `project`, an
  `outcome` (`ok`, `fail`, `partial`, `check`), a `result` of one to three words that says the state
  (merged, render failed, session limit), a terse `title` without the project name, `detail`, start
  time, duration and a link to the result. Routines are not reported: skipped or scheduled runs that
  did nothing, and the brief's own runs.
- **Obsidian triage**: daily notes in `$MPX_OBSIDIAN_VAULT/Daily/` from the window and today, and
  changes to `Ideas.md`. Unchecked dump bullets and tasks not yet under a capture heading become
  items with a proposed project, heading and priority per `_Tooling/TaskGenius/task-system.md` and
  the project registry. Link each to its note with `obsidian://open?vault=<vault>&file=<path>`.
- **AI retro** (`sessions.json`): problems in sessions of both accounts and harnesses: tool errors,
  hook blocks, my corrections, repeated attempts at one step. At most five, ranked by cost, each with
  the transcript lines that show it, a concrete fix, the file it belongs in, and a prompt for a
  session that would apply the fix.
- **Instructions**: commits in the window touching agent instructions, rules, skills and decision
  records (`AGENTS.md`, `CLAUDE.md`, `DECISIONS.md`, mpx `content/`). Each change has a `kind`:
  `global` (global `AGENTS.md`/`CLAUDE.md` and shared instructions), `project`, or `skill` (with
  `added` for a new one); the page shows them in that order, skills in their own section. Per change:
  one line on what changes for agents, your opinion in one sentence with a verdict (final, watch,
  needs attention), and whether it is committed, pushed and, for mpx, built into `dist/`.
- **AI news**: at most three items newer than the window, from different vendors: Claude Code,
  Codex and Gemini releases, Anthropic, OpenAI and Google announcements, Hacker News front-page AI
  stories. Each has a `summary`, two to four `points` with the concrete changes and a `why` sentence
  on what it means for my setup. Read `$MPX_AI_DUMP/morning-brief/taste.md` when present and follow
  its preferences.

Calendar, Slack and mail come from the gatherers; the main session shapes them into chapters.
The calendar shows one column per day: earlier days the window covers (greyed as history), today,
and all of tomorrow; a day without events gets no column, only a clause in the narration. Events are
coloured by calendar and busy-only work blocks stay untitled. Slack leads with what still waits on
me, shown even when empty, then what is worth knowing, then one sentence on what I already handled;
handled messages stay listed but are not narrated one by one. A problem someone else is handling
names them (`handledBy`). Mail lists only what needs action, in a personal and a work panel;
notifications collapse into count lines per `account`, and alerts go to merge requests. Merge
requests, issues and mail are narrated personal first, then work.

## brief.json

[brief.sample.json](templates/brief.sample.json) shows every chapter type; the page template is the
authoritative reader and `build.mjs` validates it. Top level: `date`, `dayDirectory`, `now`,
`window` (`since`, `until`, `label`), `sources` (`name`, `status`, `reason`, and `chapters` the
problem affects), `projects` (`id`, `name`, `color` from `--tag-<project>-bg` in the vault's
`.obsidian/snippets/tagColors.css`; the page picks a colour for a project without one), `chapters`. Each chapter has `id`, `type`, `name`, `title`, `status` (`needs`,
`fyi`, `quiet`, `unavailable`), `count`, `beats`, and `data` for its type; quiet and unavailable
chapters carry `detail` instead. Calendar days use ISO dates as `id`; give each calendar a distinct
Google colour, list only calendars with events, and prefer a titled event over its busy-only copy.

Order: calendar, overnight, work, issues, slack, mail, triage, retro, instructions, news, actions.

Each action point has `id`, `text`, a `detail` with why and where it came from (for example, which
email warned about an expiring token), `app`, a link, its `chapter` and its `project` (a `projects`
id; `personal` or `work` for points outside a repository). Agents do the work by default;
`agent: false` with `why` marks the rare step only I can do. `source` names the target id of the
item it came from: the page puts its Approve and Dismiss control beside that item, and points
without a source gather at the foot of their chapter. A point stays open until I decide it. The
actions chapter lists every point one per line, grouped by project, with the same state; each
project chooses one follow-up agent for its approved points, one per point, or none. Its beats name
the manual steps first, then the agent work per project, and the saved choices drive the apply
session.

## Narration

Each beat is one spoken sentence (`say`), a sidebar `note` label of at most four words, and
`targets` naming the elements it lights. Target ids: run and action ids as written (an action id
lights its control on the source slide); `event-<id>`, `day-<day id>`, `card-<id>`,
`column-<board column>`, `issue-<id>`, `issue-column-<column name, lowercase and hyphenated>`,
`auto-<id>`, `message-<id>`, `slack-waiting` (empty), `slack-addressed`, `mail-<id>`,
`mail-empty-<account>`, `task-<id>`, `retro-<id>`, `change-<id>`, `news-<id>`, `project-<id>` (a
project group on overnight runs and action points). `select` opens a calendar event's popover;
`scope` switches work and personal on merge requests and issues and, on mail, keeps that panel
bright while the other dims.
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

## Deliver

Report the `file:///` link to `index.html` first, then sources that were unavailable and why, the
gatherer cost, narrated characters, and action point count. The page is local. Publish it as an artifact only when asked,
from the work account; before sharing beyond me, ask whether personal mail and calendar items stay.
End with the [result line]({{MPX_SHARED_INSTRUCTIONS}}/RESULT_LINE.md) linking the page.
