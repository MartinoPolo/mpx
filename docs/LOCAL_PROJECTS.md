# Local directory projects

MPX supports explicitly configured local directory roots that are not Git repositories. Put an
`mpxconfig.json` at the exact directory root:

```json
{
  "$schema": "https://mpx.dev/schemas/mpxconfig.schema.json",
  "schemaVersion": 1,
  "project": {
    "id": "local/home",
    "kind": "directory"
  }
}
```

The project ID must use the same canonical `owner/name` format as repository-backed projects. A
directory project must set `project.kind` to `"directory"` and must not contain a `repository` field
or a fabricated Git remote.

Directory project discovery is root-only: the config applies when the requested working directory
resolves to the config's directory, but it is not inherited by descendants. Repository-backed
project configs remain unchanged, omit `project.kind`, require `repository.provider` and
`repository.remote`, and retain ancestor discovery up to a `.git` boundary.
