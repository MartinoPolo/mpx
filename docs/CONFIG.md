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

Resolved skill artifacts bind launch identity, the complete effective validated skill policy, effective policy hash, runtime, content-scope context, project, effective packs, and canonical catalog hash. The four-state contract uses manifest schema version 3 and artifact-reference schema version 3, so earlier artifacts are stale. Initial model context includes full metadata only for `full`, a name only for `name-only`, and nothing for `explicit-only` or `off`. Consequently `clean` keeps all trusted members human-searchable and human-invocable while contributing zero catalog metadata to initial model context. Human list and completion expose sorted names only; explicit human detail and search may expose descriptions. Model search is launch-artifact-bound and limited to `full`/`name-only`; actual slash/UI/CLI invocation is the only route for `explicit-only`. Only an actual slash/UI/CLI action counts as explicit human invocation.

## Post-create preparation contract

`worktrees.postCreate.execution` is exactly `foreground`, `background`, or `none`. Finite steps use one of three closed forms: `package-install`; `package-script` with an explicit `script`; or `executable` with an explicit argv array. Executable argv is passed as arguments, never shell text, and shell interpreters, executable paths, empty values, and control characters are rejected. Approval of package automation and the separate approval of explicit executables are runtime trust records, not committed secrets or trust grants.

Every step has a safe `id` and may declare `dependsOn`, `required` (default `true`), `timeoutSeconds` (1–3600), a repository-relative slash-form `cwd`, and an `environment` allowlist containing names only. Absolute/traversing paths, duplicate or unknown dependencies, dependency cycles, duplicate environment names, and secret-bearing environment names fail closed. The exported pure `preparationPlan` API validates the project, returns a canonical dependency-respecting order (lexical among simultaneously ready steps), and supplies the fixed bounded 64 KiB output/redaction policy. Configuration cannot provide shell interpolation, environment values, log destinations, or unbounded logging declarations.

`mpx init` is a read-only plan. `mpx init --confirm` applies it: a missing suggested manifest is created, then the Git main checkout's slot-zero ports are reserved in the machine registry and `.worktree-ports.json` is projected. Existing manifests are never rewritten. Confirmation fails closed on exclusive preferred-port conflicts, and repeating a successful confirmation leaves the manifest, registry, and projection byte-identical.

Use:

```bash
mpx init --cwd . --json
mpx init --cwd . --confirm --json
mpx config validate --cwd . --json
mpx config resolve --cwd . --json
mpx config explain --cwd . --json
```

Unknown versions, providers, packs, fields, dangerous JSON keys, duplicate JSON keys, unknown references, widening declarations, and unsafe route values fail closed. Schema, semantic, and environment/interpolation validation failures are reported as `ConfigValidationError` with stable code `CONFIG_INVALID`. Normal operation never reads legacy MPX configuration.
