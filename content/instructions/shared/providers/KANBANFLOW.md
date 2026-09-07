# KanbanFlow Native Guide (`kf`)

Applies only when `issues.provider` in committed `mpxconfig.json` is `kanbanflow`. `repository.provider` still
independently controls PR and CI. `issues.boardId`, optional `issues.boardName`, and every workflow mapping in
`issues.states` come exclusively from that manifest. Never run `kf init`, infer a board from local files, remap columns
interactively, or write board configuration. Credentials remain in the OS keyring; do not request or expose them.

## Verified installed native grammar

Read-only inspection of installed `kf --help`, `kf board --help`, and `kf task list --help` confirms `task`, not
`issue`, and confirms board JSON plus structured/open listing:

```text
kf board --json
kf task list [--open] [--state todo|wip|review|done|archive] --json
kf task view <task>
kf task create --name <title> --description <body> \
    [--to todo|wip|review|done|archive] [--label <existing-label>] \
    [--responsible me|none|<user-id>] [--json]
kf task edit <task> [--name <title>] [--description <body>] \
    [--append-description <text>] [--add-label <existing-label>] \
    [--remove-label <label>] [--responsible me|none|<user-id>] [--json]
kf comment add <task> (--text <text>|--file <file>)
kf task move <task> --to todo|wip|review|done|archive
kf task finish <task> [--comment-file <file>] [--to todo|wip|review|done|archive]
kf label list
```

Before every read or write, require the single `_id` from `kf board --json` to equal configured `issues.boardId`; stop
on absence, duplication, or mismatch. Task identifiers may be a displayed number such as `E613` or native task ID.
Labels must already exist; `kf` has no label-create command. Use only canonical state names whose mappings are present
in `mpxconfig.json`; optional `archive` is unsupported when not configured. `--force`, deletion, assignment changes,
attachments, subtasks, and `grab` require separate explicit workflow authorization.

## Adapter/version boundary

The canonical MPX adapter source currently invokes the newer public `kf issue list|view|create|edit|move|finish`
grammar, with `kf comment add`; its adapter tests verify those exact argv forms. The safely inspected installed CLI
rejects `kf issue` and exposes the older `kf task` grammar above. Therefore native workflows must inspect `kf --help`
and use only the grammar actually advertised by that executable. Do not translate between `issue` and `task` by
guesswork. If a workflow requires adapter parity and installed help does not expose it, use the typed MPX Issue API when
the calling skill permits that managed interface, otherwise return a version-mismatch handoff.

KanbanFlow has no pull request, merge request, milestone, or CI operations. It has no native parent/sub-Issue hierarchy in
this contract; use body links. Board labels cannot be created by automation through this guide.
