# Working principles

Find the root cause before fixing. Claim completion only when the work is done and verified. If an
approach is getting messy or you've patched the same area repeatedly, stop and redesign instead of
polishing it.

## Code

DRY. Full descriptive names, no abbreviations. Code comments are extremely rare and explain why —
the intent or the constraint. Update documentation when behavior changes.

Avoid numeric values describing repository state in comments, docs, skills, and references. These
drift over time. Describe the general shape or point to the authoritative source instead.

Keep `AGENTS.md` edits concise and limited to durable repository-authoring intent.

## Execution

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

For implementation workflows, discover development-server and Storybook commands in `package.json`
and referenced project configuration. The parent may start a server when verification needs one,
verify readiness, and pass its URL to browser agents without an initial user prompt. Respect project
restrictions, preserve user-owned processes, and clean up only servers started by the workflow.
Missing optional MPX port metadata is not a startup blocker.

## Project instructions and skills

Follow applicable project instructions, including nested instructions for files changed. Private
local instructions supplement shared guidance.

Use skill locations exposed by the native runtime. Invoke MPX skills with their native command:
`/skill:mp-<name>` in Pi and `/mp-<name>` in Claude. Resolve compiled support content only from
the absolute `MPX_ACTIVE_CONTENT_ROOT`; do not guess an installation path.

## Sub-agents

Delegate broad discovery to the exploration agent when available. Prefer delegation for discovery
spanning more than three files or 1000 lines. Use direct tools for known paths and small lookups.
Name the agent type. Resolve and read `dist/claude/instructions/shared/SUBAGENT_PROTOCOL.md` beneath
`MPX_ACTIVE_CONTENT_ROOT` for details. When agents are unavailable, use available tools.

## Reporting

Make important files, generated artifacts, PRs, issues, and CI results easy to open with Markdown
links. Follow [Reporting Links](../shared/REPORTING_LINKS.md) for native-friendly file URIs,
canonical provider URLs, and terminal rendering; do not force a particular editor by default. Native
profiles read this policy from the stable `MPX_ACTIVE_CONTENT_ROOT` projection.

## Preferences

Prefer local documentation or Context7, with web fallback. Commands suggested for manual execution
use Bash; use PowerShell for Windows-native tooling. Use conventional commits when authorized. When
workflow friction recurs, fix the immediate issue, then propose a durable rule for instructions or
memory.
