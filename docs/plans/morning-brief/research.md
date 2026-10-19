# Morning brief: gathered requirements

Input for the `morning-brief` skill. [mockup.html](mockup.html) shows the first proposed form;
it predates the decisions below.

## Sources

- Obsidian `Ideas.md`: work summary, Kanban, retro, component of the day, Slack/Calendar/Gmail
  questions, puzzles.
- Obsidian `_Tooling/Skills.md`: "Morning skills" group (morning update, morning summary, ideas,
  YouTube).
- Obsidian `Daily/2026-10-09.md`: unresolved tasks, "AI quick questions", running before the PC
  starts.
- Obsidian `Ideas (conflict 2026-09-28-14-04-57).md`: loop-engineering refactor, AGENTS.md reviews.
- Obsidian `_Tooling/TaskGenius/task-system.md` and `TaskGenius Projects.md`: the task convention the
  triage must follow.
- Claude session `0b8660a4` (`C--AI-DUMP`): trigger and connector research; handoff
  `C:\_temp\mpx.morning-brief\handoff-from-0b8660a4.md`.
- Claude session `d79d88c2` (`C---MP-github-cloned-orca`): Orca automation patch, mpx fix `cd31df4`.
- Pi sessions: "morning skills should be grouped" (Orca, 2026-09-16); overnight AFK execution
  (Orca orchestration, 2026-09-21).

## Decided

- Trigger: the Orca automation "Morning" in `MPX_AI_DUMP`, daily at 06:00 Europe/Prague, `ccw`
  profile. Missed runs execute once when Orca starts within the grace window
  (`missedRunGraceMinutes`, 720 by default). The automation sets model and effort.
- Not Cloud Routines (no local files, Obsidian or mpx skills) and not Desktop scheduled tasks (no mpx
  skill packs).
- One brief covers personal and work. A work session orchestrates so artifacts can be shared with
  colleagues; it stays connector-free and runs one headless gatherer per account:
  `cc --connectors -p` (personal Gmail, Calendar) and `ccw --connectors -p` (work Slack). Gatherers
  use `--permission-mode dontAsk` with read-only `--allowedTools`, a time limit, and write JSON to the
  day folder.
- Ordinary `cc`/`ccw` sessions load no claude.ai connectors; only a leading `--connectors` does.
- Sources that are not connected are skipped like failed sources.
- Output: a local interactive narrated page per day. Publishing as a claude.ai artifact (from the work
  account) happens only on request.
- Style and player: modelled on `narrated-walkthrough` (chapter sidebar, cards, caption, chapter and
  overall progress bars, speed). The player is copied, not shared; the two may drift.
- Window: from the last successful brief, but never later than the start of the previous calendar
  day. The header states the covered range.
- The brief only reports and collects choices. Choices are saved from the page and applied by a
  second skill in a new Orca session in `MPX_AI_DUMP`, which also spawns fix sessions through Orca
  and mpx (`ccw`).
- Quiet areas get a short slide with one sentence and advance within seconds; the outline marks them
  as quiet.
- Out of this brief: Figma and the warm-up puzzles (separate skills and routines), component of the
  day and other improvement loops (separate automations, reported under overnight runs).
- Later: Reddit and YouTube picks; apply actions that move KanbanFlow tickets to the column matching
  their MR state and merge approved, green MRs (with monitoring and rebasing).
- Narration uses a local VoiceStudio backend (OmniVoice, 600+ languages including Czech) through
  `scripts/narrate.mjs`; when the backend is unreachable the page uses captions and the browser voice.
- The page saves choices as `morning-brief-choices-<date>.json` (download, or copy); the apply
  session reads that file.
- Any click on a link or control pauses playback; I resume when I come back.
- The deck opens with the calendar and reports section by section; each proposed action is decided
  where it arises and confirmed in the action points, which say why and where each came from, with a
  link (for example, the email that warned about an expiring token).
- Overnight icons show only the outcome: ✅ worked, ❌ failed or conflict, 👀 needs my check. Short
  words name the action.
- Merge requests: Work/Personal switch, one Kanban board whose columns show each MR, PR or branch
  state; quiet projects collapse into one line. Failed pipelines and Sentry errors from mail enrich these rows.
- Issues: a separate board per tracker (KanbanFlow at work through `kf`, GitHub personally). GitHub
  closes issues from merged PRs; KanbanFlow columns are moved by hand, so a lagging issue gets a
  proposed move that the apply session makes.
- Triage: the agent proposes project, heading and priority; the page shows them as prefilled
  selects; Apply accepts the rest as proposed.
- Retro: tool errors, hook blocks, my corrections and repeated attempts at the same step, across
  Claude and Pi on both accounts; at most five, ranked. Each fix session has its own decision; the
  apply session starts the approved ones, grouped when they touch the same repo.
- Each source runs as a parallel subagent with a time limit; a failed source shows "unavailable:
  reason" on its slide and the brief still publishes.
- History: `MPX_AI_DUMP/morning-brief/<date>/` per day, plus `state.json` with the last successful
  brief time. Day folders are disposable once read.
- AI news: at most three items, newer than the window. Claude Code, Anthropic and Codex first, then
  Hacker News and major releases. Each item has up/down votes; the apply session asks why and keeps
  the answers as a taste profile for the next brief.

## Areas

| Area | Content | Source |
| --- | --- | --- |
| Calendar | Earlier days of the window greyed, today and tomorrow; days without events dropped; personal and work merged, coloured by calendar | personal Google Calendar (`cc`); work calendar when available |
| Merge requests | Split work and personal, then by project with recent activity; Kanban of MRs/PRs with state changes; uncommitted, unpushed and plan-only work; unaddressed failed pipelines and Sentry errors | git, `gh`, `glab`, Gerrit, Orca worktrees, sessions, mail notifications |
| Issues | My open issues per tracker with linked MR state; proposed moves where a column lags its MR | `kf` (KanbanFlow), `gh` |
| Overnight runs | Work that ran between my last evening prompt and first morning prompt (implementations, renders, AFK runs); terse results, outcome icons, links; no routines | sessions, Orca automation runs, git |
| Slack | Short summary; everything directed at me (mentions, DMs, `#team-e`) with whether I answered; interesting threads from `#d-ai`, `#general`, `#devel*`; Slack-styled with permalinks | work Slack (`ccw`) |
| Mail | Mail to act on; one-line summary of notifications | personal Gmail (`cc`) |
| Obsidian triage | Recent daily-note dumps and new ideas, categorized per the task system with proposed priorities; I confirm or change them on the page | Obsidian vault |
| Retro | Problems in recent agent sessions with proposed fixes; a fix-session decision per item | Claude and Pi transcripts |
| Instructions | Changes to global and per-project instructions and to decisions | git |
| AI news | At most three items with up/down votes | Claude Code and Codex changelogs, Anthropic and OpenAI news, Hacker News, web |
| Action points | Everything that needs me, each with a link | all |

## Presentation rules

- Every MR, PR, ticket, message, event, run, screenshot gallery and crucial file is a link.
- Status words stay short; no long sentences in overnight and work state.

## Obsidian task convention (summary)

Authoritative: `_Tooling/TaskGenius/task-system.md`.

- Daily notes (`Daily/YYYY-MM-DD.md`) start with a free dump bullet, then flat `###` capture
  headings: `#AI`, `#todo`, `#quick`, `#tooling`, `#work`.
- A task's heading decides its Task Genius view (AI, Quick, Tooling, Work); prefer the heading over an
  inline tag.
- One project per task, from the registry in `_Tooling/TaskGenius/TaskGenius Projects.md` (`#p/<name>`
  or the declared plain alias).
- Status marks: `[ ]`, `[/]`, `[x]`, `[-]`. Priority uses the Tasks emoji format.
- Task Genius indexes only whitelisted paths (`Daily/`, some `_Tooling` notes, project
  `Issues/Active`); tasks written elsewhere are invisible to it.

## Known constraints

- Connector switches: `ENABLE_CLAUDEAI_MCP_SERVERS=false` loads none; unset, empty or `true` loads
  them. `disableClaudeAiConnectors: true` in any settings source wins; `deniedMcpServers` blocks a
  named connector in every session, including `--connectors` ones. Never set the variable in a
  settings `env` block, which overrides the process environment.
- Connectors come from the claude.ai account of the launching profile and load in `-p` mode.
  `claude mcp list` with `ENABLE_CLAUDEAI_MCP_SERVERS=true` and `CLAUDE_CONFIG_DIR` shows an account's
  connectors and their health.
- Connected Google accounts: the personal account (Gmail, Calendar, Drive), the work
  account (Gmail, Drive, Sheets). The work Google Calendar connector awaits company
  approval; until then the personal calendar shows the work calendar as free/busy only, and the work
  gatherer already allows its read tools. The Calendar connector exposes no Google Tasks.
- Slack mentions must be found by my Slack user ID, not by name search.
- Orca cannot vary environment or arguments per automation, and Settings rejects two launch profiles
  on the same or nested account directory ("Account directories cannot be the same or nested inside
  one another"). `orca orchestration worker-start --agent claude` cannot pick a launch profile;
  `orca terminal create --command` plus `orca terminal wait --for exit` can run any command visibly.
- Connector tool definitions stay deferred under `ENABLE_TOOL_SEARCH=auto:1` (both accounts).
- An Orca automation run closes its tab and kills the PTY on the first `done` hook from its pane
  (`Stop`, `SessionEnd`; `automation-dispatch-completion.ts`, `automation-terminal-ownership.ts`).
  Child `claude -p` sessions must not inherit `ORCA_*` variables, and the orchestrator must not end
  its turn before the page is built.
- Unattended runs cannot answer prompts: launch warnings, permission prompts, and the approval before
  publishing a new artifact. `MPX_AI_DUMP` is a shared domain with `omitConfig`, so launches there
  raise no warnings.
- Return path: a claude.ai page cannot run local commands. The page can store choices (`db`
  capability) and send a comment to a Claude session watching the artifact
  (`comments.sendToClaude`). A local page can download a choices file instead.
- Orca CLI can spawn sessions: `orca worktree create --agent --prompt`,
  `orca terminal create --worktree path:<dir> --command`, and `orca automations run <id>`. Orca's
  `orca://` protocol only handles skill-share links, so nothing in Orca starts a session from a page.
- Gemini TTS free tier: unpublished daily limits per project and model (about 10 requests a day
  reported), reset at 09:00 Prague; Google may use free-tier input for training and human review. The
  paid tier does not, at about $0.81 per hour of audio. The walkthrough engine packs several sentences
  into one request.
