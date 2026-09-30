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
- Agent metadata selects a semantic model class; `content/runtime-profiles.json` maps classes to
  harness models. Pi pins Luna classes to `gpt-6-luna` and Sol classes to `gpt-6.1-sol`; other family references can use
  provider-qualified aliases resolved by numeric version ordering. Reviewer agents use the dedicated
  `reviewer` class. A shared `thinking` value may be replaced per harness by `thinkingOverrides`; Pi
  Luna requires `high` or above. Native Pi `enabledModels` can use family patterns such as
  `openai-codex/gpt-*-luna:high`; native session defaults and history retain concrete model IDs.
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

From this repository, run `pnpm run update:pi-extensions` to update native Pi extensions for
personal then work using separate account roots; native package pins and account configs remain intact.

Pi core for `pi` and `piw` is pinned in this repository, including a checkout-local cancellation
patch. To update core, change the Pi dependency pins here, rebase the patch with `pnpm patch` /
`pnpm patch-commit`, run `pnpm install --frozen-lockfile` and the repository checks, then verify
`./node_modules/.bin/pi --version`, `mpx launch-preview pi personal`, and
`mpx launch-preview pi work`. Do not use `pi update`, `xpi update`,
`pi update --self`, or `pi update --all` to update this installation: those commands target Pi's
native self-updater rather than this repository's package and patch lockfile. Current Pi releases
reject self-updates from project-local pnpm installations when they are not under a global package
root, but use the repository workflow even if that native safeguard changes. For native packages
only, use `pnpm run update:pi-extensions` rather than a core self-update command.

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
| `execute` | Implement and verify an Issue; work stops at green CI with an open PR/MR, personal continues through confirmed merge |
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
    { "path": "${MPX_AI_DUMP}", "omitConfig": true }
  ]
}
```

Use either `config` or `omitConfig: true` (accept missing metadata). An existing `mpxconfig.json`
always takes precedence, even if invalid. Repository overrides cover linked worktrees; folder
overrides cover subfolders but not nested repositories.

For locations usable by either account, add an optional shared domain alongside the existing
`domains.personal` and `domains.work` arrays:

```json
{ "domains": { "personal": ["${MPX_PROJECTS}"], "work": ["${MPX_WORK}"], "shared": ["${MPX_AI_DUMP}"] } }
```

Shared roots accept absolute paths or approved `MPX_*` expansions. They suppress only ownership
warnings (including for descendants); explicit personal/work ownership of the current path or
main checkout still takes precedence. Shared roots cannot duplicate personal/work roots. To also
accept missing project metadata, use a matching `projectOverrides` entry with `omitConfig: true`
as above; shared domains do not suppress project configuration warnings. Inspect the result with
`mpx project config <directory>`.

### Generated outputs

- `MPX_AI_GENERATED`: saved media and the durable tutorial library.
- `MPX_AI_DUMP`: general AI scratchpad worth keeping, such as plans, reports, verification, backups, and imports.
- `MPX_TEMP`: disposable scratch files; Claude launches use it unless `CLAUDE_CODE_TMPDIR` is set.

Resolve roots from the environment, not hardcoded paths. After changing Windows user variables,
restart the terminal host so new sessions inherit them; existing processes retain their old values.
Changing a root does not migrate existing files. A shared domain removes MPX ownership warnings,
not native harness permissions or organizational data restrictions.

## Safety and troubleshooting

Pi and Claude Code own authentication, settings, and history; MPX does not copy credentials or
conversations between accounts. Orca owns worktrees, terminals, servers, and desktop notifications.
MPX safeguards prevent accidents; they are not a security sandbox.

For agent Bash calls without `timeout`, MPX supplies a 120-second default through Pi's tool-call
hook. Explicit timeouts and native execution/settings remain unchanged; choose a longer timeout
for long operations. This does not guarantee descendant cleanup. See
[scope and limitations](extensions/README.md#agent-bash-timeout-default).

For migration and recovery, see [HANDOFF.md](migration/HANDOFF.md) and
[ACCOUNT_ROLLOUT.md](migration/ACCOUNT_ROLLOUT.md).
