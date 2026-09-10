# Working principles

Find the root cause before fixing. Claim completion only when the work is done and verified. If an approach becomes
messy or needs repeated patches, stop and redesign it instead of polishing it.

## Code

Keep implementations DRY. Use full descriptive names rather than abbreviations. Comments are rare and explain why: the
intent, constraint, or rejected alternative. Update documentation when behavior changes.

Avoid numeric descriptions of repository state in comments, docs, skills, and reference files. They drift over time;
describe the general shape or point to the authoritative source instead.

Preserve unrelated user changes. Never use destructive Git commands or amend commits unless the user explicitly requests
them. Do not create a branch or commit unless asked or an explicitly invoked workflow includes that operation. Keep
repository `AGENTS.md` edits concise and limited to durable repository-authoring intent.

## Authorization and execution

A request to answer, explain, inspect, audit, or report is read-only and does not authorize file changes. A request for
a change authorizes carrying that change through implementation and verification, but not unrelated fixes, commits,
pushes, PRs, or merges unless the request or an explicitly invoked workflow includes them.

When existing changes overlap the task, work around them carefully. Stop and ask when an unexpected edit cannot be
reconciled without risking the user's work.

Run the narrowest relevant checks first, then widen to repository-required checks. Add tests where the repository
already uses tests and where they validate behavior rather than implementation prose. Report unrelated failures instead
of suppressing or fixing them.

## Content and cross-skill references

Canonical runtime content is loaded from the verified compiled projection, not from a source checkout or account
installation. Follow [CONTENT_PATHS.md](../shared/CONTENT_PATHS.md) for runtime tool paths. Do not invent installation
roots or machine-specific absolute paths.

When a referenced `/mpx:<skill>` cannot be invoked directly, inspect that skill through the active MPX content surface
and follow its instructions. Never substitute an unverified skill-like file from another checkout. Invocation input
means the arguments supplied to the active skill; capability declarations do not grant tools beyond the current session.

For MPX operations, read [MPX_CLI_BASIC.md](../shared/MPX_CLI_BASIC.md) first and
[MPX_CLI_REFERENCE.md](../shared/MPX_CLI_REFERENCE.md) only when needed. For native Issue, PR, or CI workflows,
follow [PROVIDER_ROUTING.md](../shared/PROVIDER_ROUTING.md) and only the guide selected by `mpxconfig.json`.

## Sub-agents

Name the agent type at every spawn. Only a structured runtime parameter selects a model; prose model names do not.
Follow [SUBAGENT_PROTOCOL.md](../shared/SUBAGENT_PROTOCOL.md) for semantic model classes, effort, tools, nesting, and
bounded result contracts.

Delegate broad codebase discovery to the projected `Explore` agent, which uses the exploration class, and state breadth
as quick, medium, or very thorough. Explore returns facts and evidence; the parent evaluates them and makes decisions.
Use direct tools for known paths and small targeted reads. Give every agent a self-contained prompt because it cannot
assume repository instructions, parent state, machine roots, or provider identity.

For library or framework documentation, check the configured `MPX_CLONED` collection first, then use the approved
Context7 documentation agent. Do not guess an unavailable API.

## Paths and platforms

Resolve paths outside the working directory from the documented `MPX_*` variables. An unset root is unavailable; name it
and stop that branch rather than guessing.

Commands suggested for manual execution use Bash syntax. Use PowerShell only for Windows-native behavior such as
registry, services, ACLs, or symlinks. In Windows Git Bash, discard output with `/dev/null`, never `NUL`, and remove
literal `NUL` artifacts when encountered.

## Worktrees and servers

Work in the current checkout unless the user requests isolation or an active workflow explicitly requires it. When
expected risk or churn makes isolation materially safer, recommend a worktree and wait for approval; file count alone is
not a reason to create one.

When isolation is required, use the runtime's worktree operation and follow the repository's `docs/WORKTREES.md` when
present. Do not replace session handoff with a subprocess `cd`. Before starting any development, preview, Storybook, or
end-to-end server, read the current worktree's `.worktree-ports.json` and use its assigned ports. Never assume a fixed
port or reuse another worktree's port.

## Decisions and delivery

Batch related inline decisions into one request and provide a clear recommendation with each. Use conventional commits
when a commit is authorized. On workflow friction, fix the immediate issue and then propose a durable rule or
documentation correction.
