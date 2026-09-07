# Provider contracts

MPX selects provider IDs from `mpxconfig.json`, but configuration cannot add an adapter, choose or replace a backend, or
define executable paths or command templates. The private `@mpx/providers` package contains fixed built-in GitHub/`gh`,
GitLab/`glab`, Gerrit/`git-ssh`, KanbanFlow/`kf`, and local/`filesystem` adapters in separate internal modules. The
registry also retains generic/`none` and none/`none` descriptors. There is no project, user, hidden, or embedding API
for dynamically injecting providers. Canonical descriptors carry fixed roles, capabilities, and strict schemas; adapter
provider/backend/capability disagreement and unknown provider selection fail closed.

## Roles and capabilities

`repository.provider` selects Review and CI behavior. `issues.provider` selects Issue behavior; when `issues` is absent,
resolution uses `none`. Resolution is role-aware: a provider must be registered for the selected role. Issue-only
providers such as KanbanFlow do not trigger Git remote resolution; repository selection is performed only for adapters
that require a forge repository. The current built-in declared and implemented surface is:

#### Provider: GitHub

- **Role:** repository, issues
- **Issue:** list, view, create, edit, comment, label, finish
- **Review:** view, create, update, comment, ready, merge
- **CI:** status, watch, logs, retry

#### Provider: GitLab

- **Role:** repository, issues
- **Issue:** list, view, create, edit, comment, label, finish
- **Review:** view, create, update, comment, ready, merge
- **CI:** status, watch, logs, retry

#### Provider: KanbanFlow

- **Role:** issues
- **Issue:** list, view, create, edit, comment, label, move, finish
- **Review:** —
- **CI:** —

#### Provider: Gerrit

- **Role:** repository
- **Issue:** —
- **Review:** view, create, update, comment, ready, merge
- **CI:** none implemented

#### Provider: generic Git

- **Role:** repository
- **Issue:** —
- **Review:** none implemented
- **CI:** none implemented

#### Provider: local filesystem

- **Role:** issues
- **Issue:** list, view, create, edit, comment, label, finish; dependency add/remove
- **Review:** —
- **CI:** —

#### Provider: none

- **Role:** issues
- **Issue:** none
- **Review:** —
- **CI:** —

GitHub, GitLab, and local intentionally do not declare `issue.move`; KanbanFlow is the only fixed built-in that
implements it. KanbanFlow does not declare Review or CI. Local issues are Markdown documents in an identity-owned
registered store and can rebuild configured Obsidian projections. Gerrit implements only provider-neutral Review
behavior and deliberately declares no Issue or CI capability. Its create/update operations upload an already-existing
exact local commit without committing, amending, or otherwise changing local Git state; submit leaves merge strategy to
Gerrit. Generic and none fail closed. An invocation outside the selected provider's declared set returns
`CAPABILITY_UNSUPPORTED`; an unknown or wrong-role provider fails before execution. MPX never falls back to a direct
provider command.

The capability names are `issue.{list,view,create,edit,comment,label,move,finish}`,
`review.{view,create,update,comment,ready,merge}`, and `ci.{status,watch,logs,retry}`.

## Identity-owned routes

Every operational Issue, Review, and CI command requires `--identity NAME`. MPX reads the selected provider from the
project manifest, then looks up `identities.NAME.providerRoutes[provider]` in `%APPDATA%/mpx/config.json`. A missing
identity fails with `IDENTITY_REQUIRED` or `IDENTITY_UNKNOWN`; a missing route fails with `PROVIDER_ROUTE_REQUIRED`.

A route is an opaque, identity-owned label passed to the trusted adapter. It is not a path, token, host command,
executable, private-key location, or permission grant. Route labels are validated as safe values, and neither CWD
classification nor project/content-scope configuration may select or override one. Native provider authentication
remains in `gh`, `glab`, `kf`, Git, or SSH; MPX does not copy credentials. Gerrit uses the configured safe Git remote
name for uploads and the validated host/project selector from that remote for SSH queries and reviews. Runtime-bound
direct SSH receives only the exact launch-owned `MPX_RUNTIME_ROUTE_SSH/config`; outside a runtime it uses native SSH
configuration. Git continues to receive the launch-owned `GIT_SSH_COMMAND`.

The typed canonical `issue`, `review`, and `ci` operations remain available and use these fixed adapters. Canonical
workflows may alternatively opt into the governed native guides in `content/instructions/shared/providers/`. Those
workflows resolve `issues.provider` and `repository.provider` independently from committed `mpxconfig.json`; they do not
infer selection from remotes. GitHub and GitLab commands retain launch-injected `GH_CONFIG_DIR`/`GLAB_CONFIG_DIR`
unchanged, KanbanFlow retains OS-keyring credentials and manifest-only board configuration, and local Markdown remains
on managed MPX commands. Missing tooling or unsupported native behavior fails closed rather than switching provider. Use
`mpx doctor --cwd . --json` for project-wide diagnostics; there are no provider inspection CLI routes.

With `--json`, all CLI results use the versioned envelope `{apiVersion:1, ok, data|error, warnings}`. Public errors
contain stable `code`, `message`, and `retryable`, and may include `capability`, `remediation`, and safe `details`.
Provider failures include configuration/registry codes, `CAPABILITY_UNSUPPORTED`, `EXECUTABLE_MISSING`, `AUTH_FAILURE`,
`COMMAND_FAILURE`, `INVALID_RESPONSE`, `MUTATION_OUTCOME_UNKNOWN`, and `WORKFLOW_POLICY_DENIED`.
`MUTATION_OUTCOME_UNKNOWN` is non-retryable: a mutating provider process may have succeeded even though MPX could not
determine or read back its result, so automatic repetition could duplicate the mutation. Remediation is actionable where
the implementation has one (for example, select a capable provider or configure `identity.providerRoutes`); secrets and
raw credentials are never included.
