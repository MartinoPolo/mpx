# Orca CLI

Orca hosts the user's worktrees, terminals, agent sessions and automations. This file says how to
drive it, not when: create worktrees, launch agents and send input only when the user or the running
workflow asks, and leave terminals and worktrees you did not start alone.

## Conventions

- Run `orca` from Bash. When it is not found or reports a missing launcher, report that instead of
  retrying or switching to raw `git worktree` for an Orca-managed checkout.
- Every argument is a flag: `--terminal <handle>`, `--worktree <selector>`. Handles and selectors are
  never positional.
- Prefer `path:` selectors with forward slashes (`path:C:/dir/repo`); `name:` selectors can be
  ambiguous.
- Add `--json` when the output is parsed.
- For exact flags run `orca <command> --help` for that one command. Bare `orca --help` and
  `orca agent-context --json` print every command and are far too large to load.
- Single-quote `--command`, `--prompt` and `--text` values, and prefix the call with
  `MSYS_NO_PATHCONV=1` when the text holds slash-led arguments. Long text arrives truncated: write the
  task to a file and send a short pointer to it.

## Common commands

| Goal | Command |
|---|---|
| Check the app and runtime are up | `orca status` |
| Find past agent sessions by content, with their resume command | `orca search '<query>' --scope all [--since <iso>] --json` |
| See what runs where | `orca worktree ps`; `orca terminal list [--worktree <selector>] --json` |
| New worktree, optionally with an agent | `orca worktree create --name <name> --repo path:<repo> [--base-branch <ref>] [--agent <id> --prompt '<text>']` |
| Agent in an existing checkout | `orca agent launch --agent <id> --worktree path:<dir> [--prompt '<text>'] [--model <id> --effort <level>]` |
| Terminal with a chosen launcher | `orca terminal create --worktree path:<dir> --title '<name>' --command '<command>' --json` |
| Read output | `orca terminal read --terminal <handle> [--limit <n>]` |
| Send a prompt | `orca terminal send --terminal <handle> --text '<text>' --enter --wait-submit 30` |
| Wait for an agent or command | `orca terminal wait --terminal <handle> --for tui-idle\|exit --timeout-ms <ms>` |
| Close | `orca terminal close --terminal <handle>` |
| Remove a finished worktree | `orca worktree rm --worktree path:<path> --delete-branch` |
| Projects | `orca repo list`; `orca repo add --path <git repository>` |
| Automations | `orca automations list\|show\|edit\|run\|runs` |

- `terminal create` and `agent launch` return the terminal handle; neither takes focus without
  `--focus`.
- In `--command`, use the MPX launchers (`cc`, `ccw`, `pi`, `piw`, `alfred`) to load MPX content and
  select the account; native commands `claude` and `xpi` bypass MPX. The `w` launchers are the work
  account, required under `MPX_WORK`; the plain ones are personal.
- A project without `mpxconfig.json` stops the MPX launcher at a confirmation prompt: add the file
  before launching an unattended agent there.
- `terminal send` reports whether the prompt was submitted. On silence never send it again; after a
  transport failure reissue the same command with the reported `--retry-request` id.
- `terminal send` types into whatever the tab shows. Read the terminal first: when its prompt line
  reads `Message @<agent>…`, the tab is inside a sub-agent's view and the prompt reaches that
  sub-agent, not the session's lead.
- `terminal wait` exits non-zero on timeout. That is the wait ending, not the agent failing: read the
  terminal before deciding.
- `worktree rm` stops the worktree's sessions and deregisters it; `--delete-branch` deletes the branch
  only when it is provably merged.

## Cross-provider workers

A role that needs another provider's model (Claude ↔ Codex through Pi) runs as a supervised worker,
never as a brief typed into a raw terminal:

```bash
orca orchestration worker-start --environment local --worktree current --agent <claude|pi> \
  --launch-profile <profile> --model <id> --effort <level> --task-title '<title>' --spec-file <brief>
```

- Always pass `--launch-profile`: `ccw` or `piw` under `MPX_WORK`, otherwise the personal profile.
  Without one, a worker of a different agent than yours runs the built-in personal account without MPX.
  Profiles are in Orca Settings; a missing one fails the start with the configured names.
- Take model ids from `content/runtime-profiles.json` roles: a Claude alias, or a Pi `provider/id`.
- The worker opens as a background tab and closes when it finishes. End your turn: Orca wakes you
  with `worker_done`; read more with `orca orchestration worker-read --source auto`.
- Until [orca#24](https://github.com/MartinoPolo/orca/issues/24) is fixed, a `pi` worker started
  with a launch profile leaves its spec unsubmitted: send `orca terminal send --terminal <handle>
  --enter` once after the start. Until [orca#25](https://github.com/MartinoPolo/orca/issues/25) is
  fixed, close its terminal with `orca terminal close` after `worker_done`.

## Beyond this file

- Coordinating several agents (messages, tasks, supervised workers): `orca skills get orchestration`.
- Everything else, including the embedded browser: `orca skills get orca-cli`.
