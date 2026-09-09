# Configuration

`mpxconfig.json` is the only committed project integration manifest. It uses `schemaVersion: 1`, rejects unknown fields, and contains no credentials, identities, machine roots, executable paths, assigned ports, or worktree paths.

Schemas:

- project: [`packages/config/schemas/mpxconfig.schema.json`](../packages/config/schemas/mpxconfig.schema.json)
- user-local: [`packages/config/schemas/user-config.schema.json`](../packages/config/schemas/user-config.schema.json)

## User-local configuration

`%APPDATA%/mpx/config.json` uses `schemaVersion: 2` and owns:

- explicit native runtime identities, account roots, and `allowedSkillPacks`;
- identity domains, which classify authority but never select identity;
- `locations`, each with canonical `roots` and selected `skillPacks`;
- optional per-project pack selections under `projects[projectId].skillPacks`;
- modes, presets, launch defaults, executors, and network policies;
- ordinary `resourceRoots` for `cloned-repositories`, `computer-control-config`, and `computer-control-executable-settings`;
- logical local-Issue stores and views.

Identity is explicit and immutable for a launch. It is not inferred from the working directory, project, domain, provider, or Git remote. Provider, Git, SSH, and MCP routes remain independent validated labels, not paths, credentials, commands, or permission grants.

Only complete documented `${MPX_*}` tokens are interpolated where the schema permits paths. `~` is accepted only for native runtime roots. Missing, ambiguous, unknown, cyclic, widening, secret-like, or unsafe configuration fails closed.

## Skill selection

The only canonical packs are `development` and `personal`. An identity's `allowedSkillPacks` is an allowance, not a default. Effective packs resolve in this order:

1. committed `skills.packs` in the discovered `mpxconfig.json`;
2. user-local `projects[projectId].skillPacks`;
3. the most-specific canonical containing entry in `locations`.

An unresolved or ambiguous location fails with actionable guidance. Location matching uses canonical containment and does not fabricate a repository or carry repository configuration across a Git boundary. Once a launch is resolved, changing shell directories does not mutate its inventory.

Requested packs outside the explicit identity allowance are errors; they are never silently filtered. Project and location selection cannot change identity, native account roots, credentials, or provider routes. Configure coding roots with `development`, personal asset/note roots with `personal`, and select both explicitly where needed.

A committed project can select packs without changing the schema version:

```json
{
  "schemaVersion": 1,
  "project": { "id": "owner/project" },
  "repository": { "provider": "github", "remote": "origin" },
  "skills": { "packs": ["development"] }
}
```

User-local selection has this shape (the complete file must also contain the other schema-required sections):

```json
{
  "schemaVersion": 2,
  "identities": {
    "personal": {
      "domain": "personal",
      "runtimeRoots": { "claude": "~/.claude", "pi": "~/.pi" },
      "gitAuthorRoute": "personal",
      "allowedSkillPacks": ["development", "personal"]
    }
  },
  "locations": {
    "personal-code": { "roots": ["${MPX_PROJECTS}"], "skillPacks": ["development"] },
    "personal-assets": { "roots": ["${MPX_AI_GENERATED}"], "skillPacks": ["personal"] }
  }
}
```

Named skill policies, content scopes, per-project/per-scope exposure overrides, and `off` no longer exist. There is no global `clean` switch. Canonical and opted-in managed-project skills retain metadata exposure of `full`, `name-only`, or `explicit-only`; omitted exposure on otherwise valid managed metadata defaults to `full`, with bodies still loaded lazily.

## Modes and resources

Supported modes are `project`, `developer`, `computer-control`, and `unrestricted`. Presets contain only `identity`, `mode`, `executor`, `workspace`, and `networkPolicy`; `launchDefaults` keys are `locations` and `projects`.

Mode resource admission is the configured mode plus the canonical selected resource root. Resource names do not confer authority by themselves: in particular, cloned-source access is configured through `cloned-repositories`, not a magical `oss` domain. Domains and resource locations remain separate, so reclassifying a root does not broaden identity authority.

The removed grant mechanism did not mediate reads by a host process. There are no `--grant`, `--skill-policy`, or `--content-scope` launch options. Windows host execution still requires its independent fresh approval; Docker remains unavailable without fallback.

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
