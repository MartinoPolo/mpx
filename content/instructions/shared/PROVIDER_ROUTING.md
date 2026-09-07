# Provider Routing

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable. Use this contract when a
workflow explicitly links to it. Canonical workflows may select either the typed `mpx issue`,
`mpx review`, and `mpx ci` APIs or the native guides below. Native workflows do not require MPX enrollment or a
mandatory typed facade.

## Resolve only the roles needed

From the explicit repository/board working directory, walk toward the filesystem root and stop at the nearest committed
`mpxconfig.json`. Do not skip an invalid nearer file. Parse it as JSON and validate only the project and role fields
needed by the operation.

- Issue/board work selects `issues.provider`.
- PR and CI work selects `repository.provider`.
- Resolve the roles independently. Never infer a provider from Git remotes, copy one role into the other, or select a
  provider because its CLI is installed.

Load exactly the selected [GitHub](providers/GITHUB.md), [GitLab](providers/GITLAB.md),
[KanbanFlow](providers/KANBANFLOW.md), [Gerrit](providers/GERRIT.md), or [Local](providers/LOCAL.md) guide. `generic`,
`none`, an unknown provider, a missing guide, or a role mismatch is unsupported.

## Explicit GitHub repository creation

The personal `init-github-repo` skill explicitly selects GitHub before a
repository or project configuration exists. For that workflow only, use the confirmed GitHub account, owner/name, and
visibility rather than requiring an existing configured remote. If existing project configuration selects another
repository provider, stop; do not switch it. This exception does not authorize other workflows to infer a provider.

## Validate explicit targets

Every hosted command must carry an explicit, validated repository/project target. A configured Git remote may resolve
that target, but never the provider: run `git remote get-url -- <repository.remote>` and require exactly one non-empty
result. Accept only HTTPS, `ssh://`, or SCP-style forge URLs; reject local/file paths, user-info in HTTPS,
query/fragment components, malformed ports, and empty, dot, or traversal path segments. Remove one terminal `.git`.
Preserve the complete namespace path and host. If a caller-supplied target conflicts, stop rather than choosing one
silently.

For KanbanFlow, run `kf` at the repository root, read `kf board --json`, and require its single board `_id` to equal
configured `issues.boardId` before any operation. Validate configured state mappings before movement. Local storage
remains managed by the existing MPX installation.

Use explicit Issue, PR, run, job, branch, repository, project, and board IDs. Capture returned immutable IDs and
reuse them; do not rediscover an update target implicitly. Before mutation, verify the provider, target, and intended
change. Preserve native errors and fail closed on ambiguity.

## Authentication and launch binding

Native tools own authentication. Do not login/logout, switch accounts, copy tokens, expose credential paths, or
fabricate authentication routing. When the runtime launches with account bindings such as `GH_CONFIG_DIR` or
`GLAB_CONFIG_DIR`, preserve them unchanged; this is optional runtime behavior, not a prerequisite for native operations
or a reason to enroll the project in MPX. KanbanFlow credentials remain in the OS keyring.

## Relationships, labels, and privacy

Use ordinary body links and reciprocal link sections for parent/child relationships; do not depend on native hierarchy.
Inspect existing labels before use. Create a label only when the selected guide supports it and the workflow explicitly
authorizes it; never silently create or omit one.

Send only necessary content. Never publish secrets, machine paths, private account data, raw environment values, or
unrelated logs. Prefer reviewed body files for multiline content.

## Interface boundary

- A workflow that selects a native guide uses only that guide's documented commands.
- A workflow that selects the typed MPX contract may use `mpx issue|review|ci ... --identity ... --json` as documented
  by installed generated help.
- Local managed Issues always use the existing typed MPX interface; do not replace them with direct filesystem or
  Node-workspace integration.
- Unsupported behavior becomes a bounded manual handoff, not an invented command, provider switch, or authentication
  change.
