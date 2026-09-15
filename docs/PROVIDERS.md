# Provider operations

MPX has no `mpx issue`, `mpx review`, or `mpx ci` command groups. Canonical workflows read the
nearest valid `mpxconfig.json`, resolve only the role they need, and use the matching shipped
native-command guide under `content/instructions/shared/providers`.

- `issues.provider` selects Issue and board operations.
- `repository.provider` selects pull request, CI, and repository operations.
- GitHub uses `gh`, GitLab uses `glab`, KanbanFlow uses `kf`, and Gerrit uses Git and SSH.
- Provider roles are independent. A workflow must not infer a provider from a remote or copy one
  role into another.
- Native tools retain their current authentication. Project configuration cannot define credentials,
  accounts, executables, or command templates.
- Hosted operations require an explicit validated repository, project, board, Issue, pull request,
  or run target.
- Unsupported capabilities and ambiguous targets stop with a bounded manual handoff. Mutations keep
  their workflow authorization gates; merge always requires fresh human approval.

## Local Markdown issues

The `local` Issue provider is a narrow application-owned store, not a general provider facade. A
project selects logical `store` and optional `view` names; user-local configuration maps those names
to private absolute roots.

The application store supports listing, reading, creating, updating, commenting, and dependencies.
It writes schema-versioned Markdown plus `.mpx-index.json` with validated paths, locking, and atomic
replacement. Optional Obsidian projections are restricted to the registered `MPX/...` subtree and
contain bounded metadata rather than issue bodies or private session summaries.

See [Configuration](CONFIG.md) and the canonical
[provider routing](../content/instructions/shared/PROVIDER_ROUTING.md) and
[local provider](../content/instructions/shared/providers/LOCAL.md) references.
