# KanbanFlow native reference

Run `kf` at the repository root in its unchanged authentication environment. Before reads or writes, execute `kf board --json` and require the returned board `_id` to equal `issues.boardId`; this binds the native repository registration to the project manifest. The configured `issues.states` values must also agree with the board's canonical-state mapping before moving work. Stop on missing, duplicate, or mismatched values; never run `kf init` or `kf auth` as fallback.

Supported operations:

- list/view: `kf task list --json [--state todo|wip|review|done|archive]` and `kf task view <task> --json`
- create: `kf task create --name <title> --description <body> [--to <state>] [--label <existing-label>] --json`
- edit/label: `kf task edit <task> [--name <title>] [--description <body>] [--add-label <existing-label>] [--remove-label <existing-label>] --json`
- comment: `kf comment add <task> --text <body>` (use `--file` only for an explicitly selected file)
- move: `kf task move <task> --to <canonical-state>`
- finish: `kf task finish <task> --to done` (or another explicitly approved configured terminal state)
- inspect available labels without mutation: `kf label list --json`

`<task>` is an explicit task number or ID. Do not use `--force` unless the user separately authorizes overriding ownership. KanbanFlow has no repository Review or CI capability; provide a manual handoff.
