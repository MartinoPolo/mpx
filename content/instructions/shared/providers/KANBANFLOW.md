# KanbanFlow Native Guide (`kf`)

Applies only when `issues.provider` in `mpxconfig.json` (or its explicit local override) is `kanbanflow`.
`repository.provider` still independently controls PR and CI. `issues.metadata.boardId`, optional
`issues.metadata.boardName`, and every workflow mapping in `issues.metadata.states` come exclusively
from that project configuration. Never run `kf init`, infer a board from local files, remap columns interactively, or write
board configuration. Credentials remain in the OS keyring; do not request or expose them.

## Native command contract

The KanbanFlow CLI repository defines `issue` in `src/cli.rs` and its verbs/options in
`src/commands/issue.rs`; its parser test rejects the old `task` noun. Before using this guide,
inspect installed `kf --help` and `kf issue --help`. If `issue` is unavailable, stop with a
version-mismatch handoff to update the executable. Do not rewrite these workflows to match an
obsolete binary; `kf --version` alone is insufficient.

```text
kf board --json
kf issue list [--open | --state todo|wip|review|done|archive | --column <name-or-id>] [--mine] --json
kf issue view <issue> [--json] [--download-attachments <directory>]
kf issue create --name <title> --description <body> \
    [--to todo|wip|review|done|archive] [--label <existing-label>] \
    [--responsible me|none|<user-id>] [--json]
kf issue edit <issue> [--name <title>] [--description <body>] \
    [--append-description <text>] [--add-label <existing-label>] \
    [--remove-label <label>] [--responsible me|none|<user-id>] [--json]
kf comment add <issue> (--text <text>|--file <file>)
kf issue move <issue> --to todo|wip|review|done|archive
kf issue finish <issue> [--comment-file <file>] [--to todo|wip|review|done|archive]
kf label list [--json]
```

For listing, `--open`, `--state`, and `--column` are mutually exclusive; `--state` is repeatable.
Omit `--mine` for broad board discovery unless the user requests an ownership filter.
`--description` and `--append-description` are mutually exclusive on edit. Move and finish do not
accept `--json`.

JSON results have operation-specific shapes: board returns an object with `_id`; issue list returns
an array of issue objects; view returns `{issue, comments, attachments}`; create returns `{issueId}`
with optional `number` and `attachments`; edit returns the updated issue object. Preserve the
returned `issueId` or issue `_id` as the immutable target rather than assuming a common response
envelope.

Run `kf` at the repository root. Before every read or write, require the single `_id` from
`kf board --json` to equal configured
`issues.metadata.boardId`; stop on absence, duplication, or mismatch. Issue identifiers may be a displayed
number such as `E613` or native issue ID. Labels must already exist; `kf` has no label-create
command. Use only canonical state names whose mappings are present in `mpxconfig.json` or its local override; optional
`archive` is unsupported when not configured. `--force`, deletion, assignment changes, attachments,
subtasks, and `grab` require separate explicit workflow authorization.

## Version boundary

Inspect the installed help for each required operation and use only options it advertises under
`issue`. If a required operation is missing, return a version-mismatch handoff. Attachment download
uses `issue view --download-attachments`; the separately authorized ownership-changing `issue grab`
uses `--download-dir`. Do not confuse inspection with grabbing an issue.

KanbanFlow has no pull request, merge request, milestone, or CI operations. It has no native
parent/sub-Issue hierarchy in this contract; use body links. Board labels cannot be created by
automation through this guide.
