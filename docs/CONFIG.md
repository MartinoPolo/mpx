# Configuration

`mpxconfig.json` is the only committed project integration manifest. It uses `schemaVersion: 1`, rejects unknown fields, and contains no credentials, identities, machine roots, executable paths, assigned ports, or worktree paths.

Schemas:

- project: [`packages/config/schemas/mpxconfig.schema.json`](../packages/config/schemas/mpxconfig.schema.json)
- user-local: [`packages/config/schemas/user-config.schema.json`](../packages/config/schemas/user-config.schema.json)

## User-local configuration

`%APPDATA%/mpx/config.json` owns:

- native runtime identities and roots;
- domain roots used only to classify a working directory;
- content scopes and skill packs;
- modes, skill policies, presets, and launch defaults;
- host/Docker declarations and network policies;
- logical local-Issue stores and views.

Identity is always explicit. Working-directory classification never selects identity or grants access. Provider, Git, SSH, and MCP routes are validated labels, not paths, credentials, commands, or permission grants.

Only complete documented `${MPX_*}` tokens are interpolated, and only in domain/content roots. `~` is accepted only for native runtime roots. Missing, ambiguous, unknown, cyclic, widening, secret-like, or unsafe configuration fails closed.

## Content selection

Skill packs are `core`, `work`, and `personal`. Exposure is one of `full`, `name-only`, `explicit-only`, or `off`.

Content scope selects eligible canonical content. Skill policy may narrow packs and resolves final exposure; it does not grant filesystem access. Project skills opt into managed behavior only through explicit `metadata.mpx`. Native project skills retain native interpretation.

Launch values resolve per axis from explicit input, project default for the explicit identity, content-scope default for that identity, then safe built-ins. A default cannot silently select host execution, unrestricted mode, or direct workspace.

## Providers

`repository.provider` selects the shipped native guide for pull request, CI, and repository operations. Optional `issues.provider` independently selects Issue and board operations. An invalid nearer manifest is never skipped for an ancestor.

Project configuration may identify a remote, board, logical local store, and logical view. It cannot define provider commands, executables, credentials, accounts, or authentication routes. Native tools retain their current authentication. See [Provider operations](PROVIDERS.md).

`workflow.codeReview.openAsDraft`, `markReady`, and `merge` constrain canonical workflows. They do not authorize authentication or merge; merge still requires fresh human approval.

## Worktree preparation

`worktrees.postCreate.execution` is `foreground`, `background`, or `none`. Steps are closed declarations for package installation, package scripts, or an explicit executable argv. Shell command strings, executable paths in configuration, unsafe working directories, secret-bearing environment names, unknown dependencies, and cycles are rejected.

## Initialization

```bash
mpx init --cwd . --json
mpx init --cwd . --confirm --json
mpx doctor --cwd . --json
```

`mpx init` plans by default. Confirmation atomically creates a missing manifest and initializes the main checkout's port projection. It does not overwrite an existing manifest. Docker launch remains unavailable and fails closed; host launch requires explicit one-use approval.
