# MPX

Shared skills, account-aware launchers, and project configuration for Pi and Claude Code.

## Development

Requirements: Node 22.20 or newer, pnpm, and Git Bash on Windows. From this repository:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm build
pnpm test
pnpm status
```

- Edit skills, agents, and instructions in `content/`; runtime code in `src/`; Pi adapters in `extensions/`.
- Run `pnpm build` after content changes and before launching a harness or running content tests.
  Generated `dist/` files are ignored: never edit or commit them.
- Keep retired content in its `archived/` directory and incomplete skills in `content/skills/unfinished/`;
  these are excluded from the build.
- Contributor guidance: [AGENTS.md](AGENTS.md). Design rationale: [DECISIONS.md](DECISIONS.md).

## Daily commands

Run from Git Bash in your project:

| Command | Purpose |
| --- | --- |
| `pi` / `piw` | Start Pi with the personal / work account |
| `cc` / `ccw` | Start Claude Code with the personal / work account |
| `mpx resume --list` | List resumable native sessions |
| `mpx status` | Inspect MPX resources and conflicts |
| `mpx sync --preview` | Preview account-resource synchronization |
| `mpx project setup . --preview` | Preview optional project setup |
| `mpx project config <directory>` | Inspect resolved project configuration |

The account shortcuts require MPX's `bin/` to precede native launchers on `PATH`. Check with
`type -a pi`; use `mpx launch pi personal` to bypass a shadowed `pi` shortcut.
Preview sync/setup before allowing writes; preserve unrelated native and project files.
For a narrower sync preview:

```bash
mpx sync --runtime-only --account personal --harness pi --preview
mpx sync --orca-hooks-only --harness pi --preview
```

Launch warnings require Enter to continue; Ctrl+C or Escape cancels. They never switch accounts.
Use `mpx launch-preview pi personal` to inspect without launching, or `pi --verbose` for expanded
startup details.

## Delivery skills

Use `/skill:mpx-<name>` in Pi or `/mpx-<name>` in Claude Code:

| Skill | Purpose |
| --- | --- |
| `execute` | Implement and verify an Issue; work stops at green CI with an open PR/MR, personal continues through merge and safe base synchronization |
| `commit` | Commit locally |
| `commit-push` | Commit and push |
| `pr` | Create/update a draft PR/MR and monitor CI, including commit and push |
| `ship` | Confirm and merge; `--no-auto-merge` stops at green CI |
| `playwright-test` | Standalone visual acceptance for `uncommitted`, `review:<id>`, or a feature description |

For `execute`, inline work commits locally without hosted delivery. `--no-tdd` skips creating tests,
not running existing tests; `--full-review` adds specialist reviews; `--no-auto-merge` leaves the PR/MR open.
Visual changes in `execute` and `batch-execute` also receive browser verification and a screenshot
gallery, even with `--no-tdd`. Screenshots and temporary runners are not committed or uploaded automatically.

## Project configuration

Add `mpxconfig.json` to the repository root (linked worktrees share the main checkout's configuration):

```json
{
  "projectId": "example",
  "repository": { "provider": "gitlab", "remote": "origin" },
  "issues": { "provider": "kanbanflow", "metadata": { "boardId": "example" } },
  "packageManager": "pnpm",
  "packs": ["development"]
}
```

- Only `projectId` is required. Ordinary folders can use `{ "projectId": "personal/assets" }`.
- Repository providers: GitHub, GitLab, Gerrit. Issue providers: GitHub, KanbanFlow. Configure each
  independently when its workflows need it.
- `packs: []` disables MPX global packs, not native project/account resources.
- Optional `fast_checks` and `full_checks` arrays override discovered checks by category, including
  empty arrays. Entries look like `{ "command": "pnpm test", "cwd": "." }`, relative to the repository
  root. Full verification runs both; put only deferred checks in `full_checks`.

### Machine-local configuration

`$APPDATA/mpx/config.json` holds account roots, account domains, default packs, and local overrides.
To avoid committing project metadata, add:

```json
{
  "projectOverrides": [
    { "path": "${MPX_WORK}/example", "config": { "projectId": "example" } },
    { "path": "${MPX_AI_GENERATED}", "omitConfig": true }
  ]
}
```

Use either `config` or `omitConfig: true` (accept missing metadata). An existing `mpxconfig.json`
always takes precedence, even if invalid. Repository overrides cover linked worktrees; folder
overrides cover subfolders but not nested repositories. Account-domain warnings still apply.
Inspect the result with `mpx project config <directory>`.

## Safety and troubleshooting

Pi and Claude Code own authentication, settings, and history; MPX does not copy credentials or
conversations between accounts. Orca owns worktrees, terminals, servers, and desktop notifications.
MPX safeguards prevent accidents; they are not a security sandbox.

For migration and recovery, see [HANDOFF.md](migration/HANDOFF.md) and
[ACCOUNT_ROLLOUT.md](migration/ACCOUNT_ROLLOUT.md).
