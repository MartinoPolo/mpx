# MPX configuration

`mpxconfig.json` is the only committed project integration manifest. It uses `schemaVersion: 1`, rejects unknown fields, and contains no identity, mode, preset, connection, credential, machine root, exposure preference, executable path, assigned port, or worktree path. Defaults are applied by resolver code and reported as provenance; schema validation does not mutate input.

The project editor schema is [`packages/config/schemas/mpxconfig.schema.json`](../packages/config/schemas/mpxconfig.schema.json). User-local configuration lives at `%APPDATA%/mpx/config.json` and is validated by [`packages/config/schemas/user-config.schema.json`](../packages/config/schemas/user-config.schema.json).

## User-local launch contracts

User configuration has separate closed maps for:

- `identities`: native Claude/Pi runtime roots and identity-owned Git author, provider, SSH, and explicitly non-auth-sharing MCP routes.
- `domains`: roots used only to classify the CWD. Classification never selects identity or grants access.
- `contentScopes`: catalog composition roots, skill packs, and exposure defaults only.
- `modes`: named capability/resource policies expressed only with validated symbolic resources.
- `skillPolicies`: named pack selection and four-state disclosure policies, independent from modes.
- `executors`: closed `host` and `docker` declarations.
- `networkPolicies`: named closed compositions using `allow-all`, `balanced`, or `deny-all`, or extending another named policy.
- `presets`: references composing identity, mode, skill policy, content scope, executor, workspace strategy, and network policy.
- `launchDefaults.scopes[contentScope][identity]` and `launchDefaults.projects[projectId][identity]`: safe fast-path preset selections.
- `projects`: catalog-only pack/exposure overrides keyed by a safe canonical `owner/repository` project ID.

Provider and SSH routes are labels owned by identities. They are never paths, credentials, or copied native-auth locations. Connections/routes are forbidden in content scopes and project overrides. MPX rejects unknown properties and references, secret-like keys or values, route paths, executable/private-key routes, and `shareNativeAuth: true`.

Mode resources are closed symbolic identifiers, never raw paths or CWD-derived authority: `selected-project`, `identity-domain`, `cloned-repositories`, `assistant-input`, `assistant-output`, `computer-control-config`, `computer-control-executable-settings`, and `host`. Access is `read-only`, `read-write`, or `staged-write`; the last is reserved for separately confirmed executable-bearing computer-control changes. Declarations may narrow but cannot exceed their built-in mode matrix. `unrestricted` is the only mode that can name `host`.

Skill policies contain `skillExposure` and may contain `skillPacks`. A policy's packs must remain within both its built-in pack family and the referenced content scope. `clean` has no pack filter and requires `explicit-only` by default. Its per-skill overrides may only remain `explicit-only`; they cannot add model-visible `full`/`name-only` entries or hide trusted skills with `off`.

A minimal shape is:

```json
{
  "identities": {
    "personal": { "domain": "personal", "runtimeRoots": { "claude": "~/.claude", "pi": "~/.pi/agent" }, "gitAuthorRoute": "personal" }
  },
  "domains": { "personal": ["${MPX_PROJECTS}"] },
  "contentScopes": { "personal": { "roots": ["${MPX_PROJECTS}"], "skillPacks": ["core"] } },
  "modes": {
    "project": { "resources": { "selected-project": "read-write" } },
    "developer": { "resources": { "identity-domain": "read-write", "cloned-repositories": "read-only" } }
  },
  "skillPolicies": {
    "clean": { "skillExposure": { "default": "explicit-only" } },
    "developer": { "skillPacks": ["core"], "skillExposure": { "default": "name-only", "skills": { "execute": "full" } } }
  },
  "presets": {
    "personal-dev": { "identity": "personal", "mode": "developer", "skillPolicy": "developer", "contentScope": "personal", "executor": "docker", "workspace": "clone", "networkPolicy": "implementation" }
  },
  "launchDefaults": { "scopes": { "personal": { "personal": "personal-dev" } }, "projects": {} },
  "networkPolicies": { "implementation": { "preset": "balanced", "approvedProjectAdditions": true } },
  "executors": { "host": {}, "docker": {} },
  "projects": {}
}
```

Only complete documented `${MPX_*}` tokens are interpolated, and only in `domains.*[]` and `contentScopes.*.roots[]`. `~` is accepted only in `identities.*.runtimeRoots.claude|pi` and resolves to the platform user home. No interpolation is performed in routes, names, presets, or overrides.

Domain and content-scope classification canonicalize real paths, perform Windows case-insensitive path-segment matching, and select the deterministic longest root. Missing roots do not match. An unclassified CWD is reported as `unknown` and config resolution fails closed; it never defaults to `core`. Domain classification and content-scope selection remain separate facts.

Skill packs are `core`, `work`, and `personal`. Canonical exposure states are exactly `full`, `name-only`, `explicit-only`, and `off`. Catalog exposure is first resolved as project skill, project default, content-scope skill, content-scope default, canonical default, then `name-only`. The validated launch skill policy is then applied: its optional packs narrow (never widen) the catalog packs, and its per-skill exposure or required default becomes final. Content scopes and skill policies change catalog composition only; neither grants nor widens filesystem access.

Preset identity is retained and must match the explicit identity and the identity key that selects it from launch defaults. CWD classification never infers identity. Per-axis launch precedence is direct input, canonical project-ID default for the explicit identity, deterministic longest-root content-scope default for that identity, then safe built-ins; provenance exposes only `explicit`, `user-project`, `user-scope`, or `built-in`, never matched roots. Every launch-default reference must exist and must not select host execution, unrestricted mode, or direct workspace; closed preset fields also prevent grants, extra mounts, and credential expansion. Network-policy extensions must reference existing declarations and be acyclic.

Skill resolution first produces one runtime-neutral manifest schema v4. It binds repository/project/content scope, identity, the complete effective skill policy, effective packs, public-name mapping, and every canonical source/metadata hash. Claude and Pi then derive separate artifact-reference v4 projections from that same manifest key; earlier schemas or stale file-map hashes fail closed.

Initial model context includes full metadata only for `full`, a name only for `name-only`, and nothing for `explicit-only` or `off`. Model search is exact-artifact-bound and limited to `full`/`name-only`. Human list, completion, search, and detail are separate explicit surfaces and include `explicit-only`, while `off` remains absent. Only an actual slash/UI/CLI action counts as explicit human invocation; slash-like prose is inert. Claude's generated projection represents `name-only` with neutral name compatibility and `explicit-only` with `disable-model-invocation`; these runtime-specific fields do not change the neutral manifest policy. See [Runtime adapters](RUNTIME_ADAPTERS.md).

## Project provider and workflow configuration

The committed manifest selects roles independently: `repository.provider` is required and drives Review and CI; optional `issues.provider` drives Issue commands and resolves to `none` when absent. Provider IDs are bounded safe identifiers so a trusted embedding caller can compose additional providers, but the manifest remains data-only: it cannot register an adapter or backend. At runtime the selected ID must exist in the trusted registry for its role, its provider-specific fields must satisfy that descriptor's closed schema, and a matching trusted adapter must exist for an operational capability; otherwise resolution fails closed before execution. The built-in repository providers are `github`, `gitlab`, `gerrit`, and `generic`; built-in issue providers are `github`, `gitlab`, `kanbanflow`, `local`, and `none`.

Built-in repository bindings require `remote`. KanbanFlow requires `boardId` and configured state-to-column IDs in `states.todo`, `states.wip`, `states.review`, and `states.done`, with optional `states.archive` and `boardName`. Normalization maps tasks in the configured `done` or `archive` columns to `finished`; the other configured workflow columns are `open`. `issue move --destination todo|wip|review|done|archive` resolves the state name to its configured column ID (and rejects an unconfigured state), while `issue finish` moves to the configured `done` column. See [Provider contracts](PROVIDERS.md) for what is actually implemented.

Project selection is not authentication selection. Every operational `mpx issue`, `mpx review`, and `mpx ci` command requires `--identity NAME`; MPX then resolves `identities.NAME.providerRoutes[configuredProvider]`. For example:

```json
{
  "identities": {
    "personal": {
      "domain": "personal",
      "runtimeRoots": { "claude": "~/.claude", "pi": "~/.pi/agent" },
      "gitAuthorRoute": "personal",
      "providerRoutes": { "github": "personal-gh", "kanbanflow": "personal-kf" }
    }
  }
}
```

Route values are opaque labels owned by the identity. They cannot be paths, executable or private-key locations, credentials, or provider commands; they do not grant access. Content scopes and project overrides cannot contain routes, and CWD/domain classification never infers an identity. A missing explicit identity, unknown identity, or absent route fails closed as `IDENTITY_REQUIRED`, `IDENTITY_UNKNOWN`, or `PROVIDER_ROUTE_REQUIRED`.

`workflow.codeReview.openAsDraft` determines whether `mpx review create` opens a draft (default `false`). `markReady` and `merge` are each `human` or `agent`. They are ceilings: `human` denies the corresponding `mpx review ready` or `mpx review merge` command with `WORKFLOW_POLICY_DENIED`; `agent` permits invocation but does not bypass provider authentication or repository policy.

## Post-create preparation contract

`worktrees.postCreate.execution` is exactly `foreground`, `background`, or `none`. Finite steps use one of three closed forms: `package-install`; `package-script` with an explicit `script`; or `executable` with an explicit argv array. Executable argv is passed as arguments, never shell text, and shell interpreters, executable paths, empty values, and control characters are rejected. Approval of package automation and the separate approval of explicit executables are runtime trust records, not committed secrets or trust grants.

Every step has a safe `id` and may declare `dependsOn`, `required` (default `true`), `timeoutSeconds` (1–3600), a repository-relative slash-form `cwd`, and an `environment` allowlist containing names only. Absolute/traversing paths, duplicate or unknown dependencies, dependency cycles, duplicate environment names, and secret-bearing environment names fail closed. The exported pure `preparationPlan` API validates the project, returns a canonical dependency-respecting order (lexical among simultaneously ready steps), and supplies the fixed bounded 64 KiB output/redaction policy. Configuration cannot provide shell interpolation, environment values, log destinations, or unbounded logging declarations.

`mpx init` is a read-only plan. `mpx init --confirm` applies it: a missing suggested manifest is published with an atomic create-if-absent operation, then the Git main checkout's slot-zero ports are reserved in the machine registry and `.worktree-ports.json` is projected. Publication uses an invocation-owned durable temporary and cleans up only that owned artifact; unsupported hard-link publication falls back to an exclusive copy without overwriting concurrent output. If port initialization fails, MPX rolls back a manifest created by that invocation only while it remains the same unchanged regular file. Preexisting, modified, or replaced manifests and unrelated files are preserved. A failed projection compensates only the exact newly created identity-bound lease and restores any displaced lease and projection; dual failures are reported with stable sanitized codes. Confirmation fails closed on exclusive preferred-port conflicts, and repeating a successful confirmation leaves the manifest, registry, and projection byte-identical.

Runtime launch uses the resolved v2 descriptor and exact immutable runtime projection. Docker remains the safe default and currently fails its production gate pending F2 rather than falling back to host. Host compatibility execution requires an explicit nonempty reason and a fresh direct-TTY approval.

Use:

```bash
mpx init --cwd . --json
mpx init --cwd . --confirm --json
mpx config validate --cwd . --json
mpx config resolve --cwd . --json
mpx config explain --cwd . --json
```

Unknown versions, providers, packs, fields, dangerous JSON keys, duplicate JSON keys, unknown references, widening declarations, and unsafe route values fail closed. Schema, semantic, and environment/interpolation validation failures are reported as `ConfigValidationError` with stable code `CONFIG_INVALID`. Normal operation never reads legacy MPX configuration.
