# Repository authoring policy

## Working principles

- Find the root cause before fixing. Claim completion only after implementation and verification.
- If an approach becomes messy or needs repeated patches, stop and redesign it.
- Preserve unrelated user changes. Do not use destructive Git commands or amend commits unless explicitly asked.
- Make requested changes rather than only proposing them. Do not fix unrelated defects.

## Authoring

- Keep implementations DRY and use descriptive names.
- Keep comments rare. Explain only a non-obvious reason, constraint, or rejected alternative.
- Update documentation when behavior changes. Remove an obsolete rule instead of adding a comment that says the new behavior succeeded.
- Avoid numeric descriptions of repository state in durable prose because they become stale.
- In Windows Git Bash, discard output with `/dev/null`, never `NUL`; remove literal `NUL` artifacts when encountered.
- Do not use em dashes in generated prose.
- Keep edits to repository `AGENTS.md` files concise and limited to durable repository-authoring intent.

## Decisions

- Batch related inline user decisions into one request instead of interrupting after each item.
- Give a clear recommendation with every decision request.

## Repository and worktree discipline

- Resolve machine roots from `MPX_*` environment variables. Do not guess absolute paths.
- Confirm the MPX repository root and current worktree before editing or running commands.
- Work in the current checkout by default. User or workflow can override this and use worktree. Worktree creation is recommended for high-risk/churn tasks. For worktree creation, follow `docs/WORKTREE_HUB.md`.
- Before starting a development, preview, Storybook, or end-to-end server, read this worktree's `.worktree-ports.json` and use its assigned port. Never assume a fixed port or reuse another worktree's port.

## MPX operations

- Read [MPX_CLI_BASIC.md](../shared/MPX_CLI_BASIC.md) before using MPX commands.
- Read [MPX_CLI_REFERENCE.md](../shared/MPX_CLI_REFERENCE.md) only when the basic reference is insufficient.

## Verification

- Run the narrowest relevant checks first, then widen to the repository-required checks.
- Report evidence for completed work and identify unrelated failures without suppressing them.
- Use conventional commits when a commit is requested.
