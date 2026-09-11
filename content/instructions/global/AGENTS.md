# Working principles

Find the root cause before fixing. Claim completion only when the work is done and verified. If an approach is getting
messy or you've patched the same area repeatedly, stop and redesign instead of polishing it.

## Code

DRY. Full descriptive names, no abbreviations. Code comments are extremely rare and explain why — the intent or the
constraint. Update documentation when behavior changes.

Avoid numeric values describing repository state in comments, docs, skills, and references. These drift over time.
Describe the general shape or point to the authoritative source instead.

Keep `AGENTS.md` edits concise and limited to durable repository-authoring intent.

## Execution

Requests to answer, explain, inspect, or report are read-only. Requested changes include implementation and verification.
Commits, pushes, PRs, and merges require a request or an explicitly invoked workflow.

During implementation, attempt to fix even unrelated errors, especially blockers. If a fix attempt fails, undo only
that attempt. Always report both resolved and unresolved issues to the user. Commit unrelated fixes separately if
committing is authorized.

Run the narrowest relevant checks first, then repository checks. Add tests where the repository already uses them and
where they validate behavior.

Prefer bounded, path-scoped reads (e.g. `git diff -- <files>`). Read full logs only when the relevant tail is insufficient.

Discover dev-server and Storybook commands in `package.json` and referenced configuration. Missing MPX port metadata must
not block startup; use project defaults. If a port is occupied, choose another only when the server and dependent URLs
can be configured reliably; otherwise ask before stopping the existing server.

## Project instructions and skills

Follow applicable project instructions, including nested instructions for files changed. Private local instructions
supplement shared guidance.

Use skill locations exposed by the runtime. When installed, the shared MPX skill collection is at
`~/.agents/skills/mpx/`.

## Sub-agents

Delegate broad discovery to the exploration agent when available. Prefer delegation for discovery spanning more than
three files or 1000 lines. Use direct tools for known paths and small lookups. Name the agent type. See the installed
`~/.agents/instructions/shared/SUBAGENT_PROTOCOL.md` for details. When agents are unavailable, use available tools.

## Preferences

Prefer local documentation or Context7, with web fallback. Commands suggested for manual execution use Bash; use
PowerShell for Windows-native tooling. Use conventional commits when authorized. When workflow friction recurs, fix the
immediate issue, then propose a durable rule for instructions or memory.
