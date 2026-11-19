# Morning brief: gathered requirements

Input for the `morning-brief` skill, which writes the daily brief document the Alfred control center
shows.

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
- Claude session `0b8660a4` (`C---ALFRED-work`): trigger and connector research; handoff
  `C:\_temp\mpx.morning-brief\handoff-from-0b8660a4.md`.
- Claude session `d79d88c2` (`C---MP-github-cloned-orca`): Orca automation patch, mpx fix `cd31df4`.
- Pi sessions: "morning skills should be grouped" (Orca, 2026-09-16); overnight AFK execution
  (Orca orchestration, 2026-09-21).

## Decided

- Trigger: the Orca automation "Morning" in `MPX_AI_RETAINED`, daily at 06:00 Europe/Prague, `ccw`
  profile. Missed runs execute once when Orca starts within the grace window
  (`missedRunGraceMinutes`, 720 by default). The automation sets model and effort.
- Not Cloud Routines (no local files, Obsidian or mpx skills) and not Desktop scheduled tasks (no mpx
  skill packs).
- One brief covers personal and work. The orchestrating session stays connector-free and runs one
  headless gatherer per account: `cc --connectors -p` (personal Gmail, Calendar) and
  `ccw --connectors -p` (work Slack). Gatherers use `--permission-mode dontAsk` with read-only
  `--allowedTools`, a time limit, and write JSON to the day folder.
- Ordinary `cc`/`ccw` sessions load no claude.ai connectors; only a leading `--connectors` does.
- Sources that are not connected are skipped like failed sources.
- Window: from the last successful brief, but never later than the start of the previous calendar
  day.
- The brief only reports and suggests; the control center collects the decisions and carries them
  out.
- Narration uses a local VoiceStudio backend (OmniVoice, 600+ languages including Czech) through
  `scripts/narrate.mjs`.
- Out of this brief: Figma and the warm-up puzzles (separate skills and routines), component of the
  day and other improvement loops (separate automations, reported under overnight runs), and the
  issue boards, AI retro and instruction changes, which belong to a weekly brief.
- Each area runs as a parallel subagent with a time limit; a failed area is a source not read and
  the brief still publishes.
- History: `MPX_AI_RETAINED/morning-brief/<date>/` per day, plus `state.json` with the last successful
  brief time. Day folders are disposable once read.

## Areas

| Area | Content | Source |
| --- | --- | --- |
| Calendar | Earlier days of the window, today and tomorrow; personal and work merged, coloured by calendar | personal Google Calendar (`cc`); work calendar when available |
| Merge requests | Work and personal MRs/PRs with their state; failed pipelines | git, `gh`, `glab`, Gerrit, Orca worktrees, sessions, mail notifications |
| Overnight runs | Work that ran between my last evening prompt and first morning prompt (implementations, renders, AFK runs); terse results and links; no routines | sessions, Orca automation runs, git |
| Slack | Everything directed at me (mentions, DMs, `#team-e`) with whether I answered; interesting threads from `#d-ai`, `#general`, `#devel*`, with permalinks | work Slack (`ccw`) |
| Mail | Mail to act on; notifications collapsed | personal Gmail (`cc`) |
| Obsidian triage | Recent daily-note dumps and new ideas, with a proposed destination and priority per the task system | Obsidian vault |
| AI news | The lead story and new model releases | Claude Code and Codex changelogs, OpenAI and Google news, Hacker News |

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
  its turn before the document is written and voiced.
- Unattended runs cannot answer prompts: launch warnings, permission prompts, and the approval before
  publishing a new artifact. `MPX_AI_RETAINED` is a shared domain with `omitConfig`, so launches there
  raise no warnings.
- Orca CLI can spawn sessions: `orca worktree create --agent --prompt`,
  `orca terminal create --worktree path:<dir> --command`, and `orca automations run <id>`.
