# MPX configuration

`mpxconfig.json` is the only committed project integration manifest. It uses `schemaVersion: 1`, rejects unknown fields, and contains no credentials, executable paths, assigned ports, worktree paths, or personal account names.

The editor schema is [`packages/config/schemas/mpxconfig.schema.json`](../packages/config/schemas/mpxconfig.schema.json). Defaults are applied by the resolver and reported as provenance; schema validation does not mutate input.

User-local scope and project preferences live at `%APPDATA%/mpx/config.json`. Scope roots may use only a complete documented machine-root token such as `${MPX_WORK}`. Resolution canonicalizes real paths, uses Windows path-segment matching, and selects the longest root. Unresolvable roots do not classify a project.

Skill packs are `core`, `work`, and `personal`. Exposure precedence is project skill, project default, scope skill, scope default, canonical default, then `name-only`. Pack exclusion happens before exposure.

Use:

```bash
mpx config validate --cwd . --json
mpx config resolve --cwd . --json
mpx config explain --cwd . --json
```

Unknown versions, providers, packs, fields, dangerous JSON keys, and duplicate JSON keys fail closed. Normal operation never reads legacy MPX configuration.
