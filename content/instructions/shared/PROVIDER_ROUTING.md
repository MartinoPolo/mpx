# Provider Routing

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable. Canonical workflows invoke the native guide selected by project configuration. MPX does not provide typed Issue, Review, or CI facade commands.

## Resolve only the roles needed

From the explicit repository or board working directory, walk toward the filesystem root and stop at the nearest committed `mpxconfig.json`. Do not skip an invalid nearer file. Parse it as JSON and validate the project and role fields needed by the operation.

- Issue and board work selects `issues.provider`.
- PR and CI work selects `repository.provider`.
- Resolve the roles independently. Never infer a provider from Git remotes, copy one role into the other, or select a provider because its CLI is installed.

Load exactly the selected [GitHub](providers/GITHUB.md), [GitLab](providers/GITLAB.md), [KanbanFlow](providers/KANBANFLOW.md), [Gerrit](providers/GERRIT.md), or [Local](providers/LOCAL.md) guide. `generic`, `none`, an unknown provider, a missing guide, or a role mismatch is unsupported.

## Explicit GitHub repository creation

The personal `init-github-repo` skill explicitly selects GitHub before repository configuration exists. For that workflow only, use the confirmed GitHub account, owner and name, and visibility rather than requiring an existing configured remote. If existing project configuration selects another repository provider, stop. This exception does not authorize other workflows to infer a provider.

## Validate explicit targets

Every hosted command must carry an explicit, validated repository or project target. A configured Git remote may resolve that target, but never the provider: run `git remote get-url -- <repository.remote>` and require exactly one non-empty result. Accept only HTTPS, `ssh://`, or SCP-style forge URLs; reject local or file paths, user-info in HTTPS, query or fragment components, malformed ports, and empty, dot, or traversal path segments. Remove one terminal `.git`. Preserve the complete namespace path and host. If a caller-supplied target conflicts, stop rather than choosing silently.

For KanbanFlow, run `kf` at the repository root, read `kf board --json`, and require its single board `_id` to equal configured `issues.boardId` before any operation. Validate configured state mappings before movement. For local storage, use only the application entrypoint documented by its guide.

Use explicit Issue, PR, run, job, branch, repository, project, and board IDs. Capture returned immutable IDs and reuse them; do not rediscover an update target implicitly. Before mutation, verify the provider, target, and intended change. Preserve native errors and fail closed on ambiguity.

## Authentication and launch binding

Native tools own authentication. Do not log in or out, switch accounts, copy tokens, expose credential paths, or fabricate authentication routing. Preserve launch-provided bindings such as `GH_CONFIG_DIR` and `GLAB_CONFIG_DIR` unchanged. KanbanFlow credentials remain in the OS keyring.

## Relationships, labels, and privacy

Use ordinary body links and reciprocal link sections for parent and child relationships; do not depend on native hierarchy. Inspect existing labels before use. Create a label only when the selected guide supports it and the workflow explicitly authorizes it.

Send only necessary content. Never publish secrets, machine paths, private account data, raw environment values, or unrelated logs. Prefer reviewed body files for multiline content.

## Interface boundary

- Use only the selected native guide's documented commands or, for local Markdown, its documented application entrypoint.
- Unsupported behavior becomes a bounded manual handoff, not an invented command, provider switch, or authentication change.
