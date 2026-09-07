# Local Markdown Provider Guide

Applies only when `issues.provider` in committed `mpxconfig.json` is `local`. Local Issues are identity-owned managed
configuration/storage, so this guide intentionally retains the typed MPX interface rather than direct filesystem edits.

Pass the immutable launch identity and `--json` on every operation. Consult generated
[MPX CLI basic](../MPX_CLI_BASIC.md) or [complete reference](../MPX_CLI_REFERENCE.md) for the exact installed flags;
generated CLI docs are authoritative and are not manually edited.

Supported managed operations include Issue list, view, create, edit/update, comment, label, and finish, plus local
dependency add/remove when exposed by installed help. Always use explicit IDs returned by structured responses, preserve
schema versions, and fail closed on an unknown envelope. Represent parent/child relationships with reciprocal Markdown
body links; do not directly manipulate storage files or projection backlinks.

Local does not provide pull requests, merge requests, Gerrit changes, milestones, CI, or merge operations. Resolve `repository.provider`
independently for those. Local intentionally has no native `issue.move`; do not simulate it by moving or renaming
Markdown files. Missing store registration, identity, route, projection, or supported action is a managed-provider error
and manual handoff, not permission to locate or modify the backing store.
