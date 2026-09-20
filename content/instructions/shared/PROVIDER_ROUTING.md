# Provider Routing

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable.

## Resolve only the roles needed

Resolve `mpxconfig.json` from the Git main checkout, or the current directory for a non-Git folder.
If the file is absent, an explicitly configured machine-local project override may supply the same
fields; `mpx project config <directory>` inspects that configuration. Missing or invalid configuration
stops provider-dependent work.

- Issue and board work selects `issues.provider`.
- PR and CI work selects `repository.provider`.
- Resolve the roles independently. Never infer a provider from Git remotes, copy one role into the
  other, or select a provider because its CLI is installed.

For repository operations, load exactly the selected [GitHub](providers/GITHUB.md),
[GitLab](providers/GITLAB.md), or [Gerrit](providers/GERRIT.md) guide. For Issue operations, load
exactly [GitHub](providers/GITHUB.md) or [KanbanFlow](providers/KANBANFLOW.md).
`local`, `generic`, `none`, an unknown provider, a missing guide, or a role mismatch stops that branch; never substitute GitHub.

## Validate explicit targets

Every hosted command must carry an explicit, validated repository or project target. A configured
Git remote may resolve that target, but never the provider: run
`git remote get-url -- <repository.remote>` and require exactly one non-empty result. Accept only
HTTPS, `ssh://`, or SCP-style forge URLs; reject local or file paths, user-info in HTTPS, query or
fragment components, malformed ports, and empty, dot, or traversal path segments. Remove one
terminal `.git`. Preserve the complete namespace path and host. If a caller-supplied target
conflicts, stop rather than choosing silently.

Use explicit Issue, PR, run, job, branch, repository, project, and board IDs. Capture returned
immutable IDs and reuse them; do not rediscover an update target implicitly. Before mutation, verify
the provider, target, and intended change. Preserve native errors and fail closed on ambiguity.

## Authentication and launch binding

Preserve native authentication and launch-provided bindings. Do not log in or out, switch accounts,
copy tokens, or expose credentials.

## Relationships, labels, and privacy

Use reciprocal body links for parent/child relationships, not native hierarchy.

Inspect existing labels and milestones; use exact provider values. Creation requires provider
support and explicit authorization. Do not silently omit required values.

Publish only necessary content; exclude secrets, machine paths, private account data, raw environment
values, and unrelated logs.

## Interface boundary

Use only the selected guide’s documented commands. If configuration, tooling, or capability blocks
an operation, stop that branch and report the role/provider, known target, operation, blocker, and
required decision or manual action. Reconcile uncertain mutations before retrying.
