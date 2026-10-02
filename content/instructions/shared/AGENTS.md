# Working principles

Find the root cause before fixing. Claim completion only when the work is done and verified. If an
approach is getting messy or you've patched the same area repeatedly, stop and redesign instead of
polishing it.

When the user signals uncertainty (e.g. “maybe” or “probably”), critically assess the proposal rather
than treating it as settled. Recommend a better alternative when warranted, with a brief rationale.

## Code

DRY. Full descriptive names, no abbreviations. Code comments are extremely rare and explain why —
the intent or the constraint. Update documentation when behavior changes.

Avoid numeric values describing repository state in comments, docs, skills, and references. These
drift over time. Describe the general shape or point to the authoritative source instead.

## Documentation

When changing documentation, check for duplicates, and update or replace an existing decision
rather than append repetition or contradictory history. Doc should be stateless
(for example a note about a bug should not be left in the doc after the bug is fixed).
All documentation should be very concise and should pass a test if this will be valueable in a year

- `AGENTS.md` - limit to durable agentic instructions.
- `README.md` - focused on user-facing commands, usability and setup.
- `DECISIONS.md` - limited to durable choices and their rationale.
  Record only confirmed, lasting choices as concise bullets
  Save only what a fresh session cannot easily explore from the repository, its config, or a
  cloned upstream source; for a narrowly scoped fact, prefer a code comment. Pointers to authoritative
  files are encouraged to speed that exploration. Reserve memory for decisions, rationale, time-costly
  gotchas, and machine- or person-specific setup.

## Execution

Agents may run in sandboxes. Report inaccessible paths or websites, why access was needed, and any
available error or block details.

Requests to answer, explain, inspect, or report are read-only. Requested changes include
implementation and verification. Commits, pushes, PRs, and merges require a request or an explicitly
invoked workflow.

During implementation, attempt to fix even unrelated errors, especially blockers. If a fix attempt
fails, undo only that attempt. Always report both resolved and unresolved issues to the user. Commit
unrelated fixes separately if committing is authorized.

Run the narrowest relevant checks first, then repository checks. Add tests where the repository
already uses them and where they validate behavior.

Prefer bounded, path-scoped reads (e.g. `git diff -- <files>`). Read full logs only when the
relevant tail is insufficient.

Give finite diagnostics an explicit absolute tool timeout and network connection/read timeouts,
choosing longer bounds for legitimate long operations. Handle EOF and clean up in `finally`;
a timeout is failed verification, not success.

For implementation workflows, discover development-server and Storybook commands in `package.json`
and referenced project configuration. The parent may start a server when verification needs one,
verify readiness, and pass its URL to browser agents without an initial user prompt. Respect project
restrictions, preserve user-owned processes, and clean up only servers started by the workflow.
Missing optional MPX port metadata is not a startup blocker.

## Files outside repositories

- `MPX_TEMP`: disposable files (scripts, screenshots, logs); may be deleted tomorrow.
- `MPX_AI_DUMP`: general AI scratchpad worth keeping (plans, reports, artifacts, build workspaces).
- `MPX_AI_GENERATED`: final outputs only (rendered videos, podcasts, images), never build workspaces.

Prefer grouping a task's files in one folder named `<project>.<task-or-worktree>`, or just `<task>`.

## Project instructions and skills

Follow applicable project instructions, including nested instructions for files changed. Private
local instructions supplement shared guidance.

Invoke MPX skills with their native command: `/skill:mpx-<name>` in Pi and `/mpx-<name>` in Claude.

## Sub-agents

Delegate broad discovery to the exploration agent using direct tools for known paths and small
lookups. Exploration agents only locate files, symbols, references, and supporting evidence; never
ask them to diagnose root causes, evaluate correctness, recommend changes, or make implementation
decisions. The parent or a reasoning-capable specialist synthesizes their findings. Give delegates
the task scope, relevant constraints, stopping condition, and required evidence. The parent evaluates
findings and owns decisions. Prefer declared agent model and effort defaults; use supported overrides
only when needed. For external-tool implementation questions, check a relevant clone under
`MPX_CLONED`; use Context7 for current API documentation, with public web fallback.

## Preferences

Commands suggested for manual execution use Bash; use PowerShell for Windows-native tooling. In Bash, redirect to `/dev/null`, never `nul`. Use conventional commits when authorized. When
workflow friction recurs, fix the immediate issue, then propose a durable rule for instructions or
memory.
