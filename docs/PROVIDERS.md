# Provider contracts

MPX selects provider IDs from `mpxconfig.json`, but configuration cannot add an adapter, choose or replace a backend, or define executable paths or command templates. The private `@mpx/providers` package contains the fixed built-in GitHub/`gh`, GitLab/`glab`, KanbanFlow/`kf`, and local/`filesystem` adapters in separate internal modules. The registry also retains Gerrit/`git-ssh`, generic/`none`, and none/`none` descriptors. There is no project, user, hidden, or embedding API for dynamically injecting providers. Descriptors, roles, capabilities, strict schemas, and descriptor/adapter provider/backend agreement are validated, and unregistered, mismatched, malformed, duplicate, or untrusted composition fails closed.

## Roles and capabilities

`repository.provider` selects Review and CI behavior. `issues.provider` selects Issue behavior; when `issues` is absent, resolution uses `none`. Resolution is role-aware: a provider must be registered for the selected role. Issue-only providers such as KanbanFlow do not trigger Git remote resolution; repository selection is performed only for adapters that require a forge repository. The current built-in declared and implemented surface is:

| Provider         | Role               | Issue                                                                         | Review                                      | CI                         |
| ---------------- | ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------- | -------------------------- |
| GitHub           | repository, issues | list, view, create, edit, comment, label, finish                              | view, create, update, comment, ready, merge | status, watch, logs, retry |
| GitLab           | repository, issues | list, view, create, edit, comment, label, finish                              | view, create, update, comment, ready, merge | status, watch, logs, retry |
| KanbanFlow       | issues             | list, view, create, edit, comment, label, move, finish                        | —                                           | —                          |
| Gerrit           | repository         | —                                                                             | none implemented                            | none implemented           |
| generic Git      | repository         | —                                                                             | none implemented                            | none implemented           |
| local filesystem | issues             | list, view, create, edit, comment, label, move, finish; dependency add/remove | —                                           | —                          |
| none             | issues             | none                                                                          | —                                           | —                          |

GitHub and GitLab intentionally do not declare `issue.move`. KanbanFlow does not declare Review or CI. Local issues are Markdown documents in an identity-owned registered store and can rebuild configured Obsidian projections; local movement requires an explicitly composed board-promotion adapter. Gerrit remains explicitly pending and declares no operational capabilities in this phase; generic and none likewise fail closed. An invocation outside the selected provider's declared set returns `CAPABILITY_UNSUPPORTED`; an unknown or wrong-role provider fails before execution. MPX never falls back to a direct provider command.

The capability names are `issue.{list,view,create,edit,comment,label,move,finish}`, `review.{view,create,update,comment,ready,merge}`, and `ci.{status,watch,logs,retry}`.

## Identity-owned routes

Every operational Issue, Review, and CI command requires `--identity NAME`. MPX reads the selected provider from the project manifest, then looks up `identities.NAME.providerRoutes[provider]` in `%APPDATA%/mpx/config.json`. A missing identity fails with `IDENTITY_REQUIRED` or `IDENTITY_UNKNOWN`; a missing route fails with `PROVIDER_ROUTE_REQUIRED`.

A route is an opaque, identity-owned label passed to the trusted adapter. It is not a path, token, host command, executable, private-key location, or permission grant. Route labels are validated as safe values, and neither CWD classification nor project/content-scope configuration may select or override one. Native provider authentication remains in `gh`, `glab`, or `kf`; MPX does not copy credentials.

## Inspection and diagnostics

```bash
mpx provider list --json
mpx provider list --role repository --json
mpx provider list --role issues --json
mpx provider explain repository --cwd . --json
mpx provider explain issues --cwd . --json
mpx provider doctor --cwd . --identity personal --json
```

`provider explain` reports the configured provider, trusted backend, role-filtered capabilities, and that route selection is identity-required; it does not select or expose a route. `provider doctor` checks both configured roles for an explicit identity and reports each provider as `ready` or `unsupported`; a capable provider without a route fails closed.

With `--json`, all CLI results use the versioned envelope `{apiVersion:1, ok, data|error, warnings}`. Public errors contain stable `code`, `message`, and `retryable`, and may include `capability`, `remediation`, and safe `details`. Provider failures include configuration/registry codes, `CAPABILITY_UNSUPPORTED`, `EXECUTABLE_MISSING`, `AUTH_FAILURE`, `COMMAND_FAILURE`, `INVALID_RESPONSE`, `MUTATION_OUTCOME_UNKNOWN`, and `WORKFLOW_POLICY_DENIED`. `MUTATION_OUTCOME_UNKNOWN` is non-retryable: a mutating provider process may have succeeded even though MPX could not determine or read back its result, so automatic repetition could duplicate the mutation. Remediation is actionable where the implementation has one (for example, select a capable provider or configure `identity.providerRoutes`); secrets and raw credentials are never included.
