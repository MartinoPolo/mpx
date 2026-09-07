# Local Markdown issues

The built-in `local` issues provider stores provider-neutral issue records in a configured,
project-owned directory. It has no CLI/plugin dependency and does not use MPX private
native state.

```json
{
  "issues": {
    "provider": "local",
    "root": "issues",
    "views": {
      "vaultRoot": "C:/Users/me/Obsidian/MyVault",
      "outputRoot": "C:/Users/me/Obsidian/MyVault/MPX/Issues/acme-app",
      "resumeBaseUrl": "mpx://resume"
    }
  }
}
```

`root` is resolved from the project root. MPX rejects roots in `.git`, `.mpx`, or
`node_modules`, symlinked path components, and unsafe issue identifiers. Each root owns
its own monotonic counter and crash-recoverable atomic lock. Issue files are versioned
Markdown with JSON-compatible YAML frontmatter; this keeps scalars unambiguous while
remaining readable by YAML tools. Unknown frontmatter lines and body content after
`<!-- mpx:preserve -->` survive known-field updates.

Mutations may pass the `providerData.local.revision` returned by a read as `--revision`.
A changed on-disk file then produces `LOCAL_ISSUE_CONFLICT` instead of overwriting an
external edit.

## CLI

Local commands need no identity/provider authentication route:

```text
Read: validate .mpx-index.json, then open the indexed Markdown file for the explicit ID.
Write: acquire .mpx-issues.lock, atomically replace the issue file, then update the index under the same lock.
```

`view`/`edit`/`finish` remain supported aliases. Dependency frontiers contain the
unfinished leaf prerequisites; cycles are reported with `cycle: true` and an empty
frontier.

## Optional projections

`rebuildObsidianIssueViews(store, config)` and
`rebuildObsidianSessionViews(sessions, config)` are explicit rebuild APIs. They only
accept an `MPX/...` subtree under the configured vault, never read vault notes, write
privacy-safe metadata without issue bodies or private session summaries, and remove
stale generated views. Resume links must use the `mpx://` scheme. Calling either API
repeatedly is idempotent.
The `views` block above is manual configuration for callers that opt into this API; no
vault is read or written merely because the block exists.

The fixed local adapter does not advertise `issue.move`; invoking it returns structured
`CAPABILITY_UNSUPPORTED` before any local issue mutation. Board movement is available only
through a fixed built-in provider that declares it, such as KanbanFlow.
