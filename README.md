# MPX

MPX is the shared agent configuration for Pi and Claude Code. It provides account-aware launchers,
project-selected skill packs, native safeguards, session resume, and a deterministic Claude/Pi content
build. Native harnesses continue to own authentication, settings, packages, and conversation history.

## Daily commands

Run these from Git Bash:

| Command | Purpose |
| --- | --- |
| `pi` / `piw` | Start Pi with the personal / work account |
| `cc` / `ccw` | Start Claude Code with the personal / work account |
| `mpx resume --list` | List resumable native sessions |
| `mpx status` | Inspect MPX resources and conflicts |
| `mpx sync --preview` | Preview account-resource synchronization |
| `mpx sync --runtime-only --account personal --harness pi --preview` | Preview one account/harness runtime scope |
| `mpx sync --orca-hooks-only --harness pi --preview` | Preview only Orca-owned Pi extension mirroring |
| `mpx project setup --preview` | Preview optional project setup |
| `mpx project config <directory>` | Inspect `mpxconfig.json` or its local override |

Bare `mpx` and the account commands use the MPX installation. Legacy recovery and suffixed launchers
are removed. PowerShell and the Windows `mpx.cmd` shim explicitly select Git Bash rather than the
Windows/WSL `bash` executable. Reopen existing terminals after migration to discard cached routing.

Pi launchers leave the startup overview at its native compact default rather than forcing verbose
output. Pass `pi --verbose` or `piw --verbose` when expanded resource paths are useful.

## Execution and delivery skills

Use `/skill:mpx-<name>` in Pi or `/mpx-<name>` in Claude Code:

| Skill | Endpoint |
| --- | --- |
| `execute` | Implement and verify; work stops at green CI with an open PR/MR, personal continues through merge and safe base synchronization |
| `commit` | Local commit only |
| `commit-push` | Commit and push |
| `pr` | Commit, push, create/update a draft PR/MR, and monitor CI |
| `ship` | Confirmed merge; `--no-auto-merge` stops at green CI |

`execute --no-tdd` skips creating tests during implementation, not running existing tests.
`--full-review` adds specialist review axes; `--no-auto-merge` leaves the PR/MR open. Inline work
commits locally without hosted delivery. Shipping stops after its shared retry budget is exhausted.
Base synchronization requires an identified idle checkout, clean Git state, correct upstream, and
a fast-forward-only update. A confirmed merge and blocked synchronization are reported separately.

## Project configuration

A repository may define `mpxconfig.json`:

```json
{
  "projectId": "example",
  "repository": { "provider": "gitlab", "remote": "origin" },
  "issues": { "provider": "kanbanflow", "metadata": { "boardId": "example" } },
  "packageManager": "pnpm",
  "packs": ["development"]
}
```

Repository and Issue providers are independent and optional. Ordinary folders can use a minimal
`mpxconfig.json` such as `{ "projectId": "personal/assets" }`, without inventing a repository or tracker.
A provider-dependent workflow still requires its corresponding role. Supported repository providers
are GitHub, GitLab, and Gerrit; supported Issue providers are GitHub and KanbanFlow. An explicit empty `packs` array
loads no MPX global packs while retaining native project and account resources. Linked worktrees use
the main checkout's configuration.

Optional `fast_checks` and `full_checks` arrays contain `{ "command": "pnpm test", "cwd": "." }`
entries. Working directories are relative to the repository root. Each explicit array overrides its
discovery category, including an empty array. Complete verification runs both arrays; `full_checks`
contains deferred checks rather than a duplicate of fast checks. Explicit configuration takes
precedence over deterministic script discovery, with unresolved discovery investigated by the checker.
Formatting runs before parallel checks/review and may write files; other checks must not repair code.
The bundled detector accepts `node "<detector>" "<checkout>" "<package-manager-or-empty>" "<config-json-file>"`
when resolved main-checkout configuration or machine-local overrides must be supplied. Pass only the
resolved `config` object, not the surrounding `mpx project config` result. Detector `cwd` values are
relative to the checkout passed to it.

User configuration lives at `$APPDATA/mpx2/config.json` and maps personal/work Pi and Claude roots,
recursive domain roots, optional default packs, executable overrides, and local project overrides.
Domain ownership and project configuration are independent: a personal folder can still have missing
or invalid project metadata. MPX never copies credentials or conversation history between profiles. Claude's explicitly configured native permission mode,
including Auto, is preserved; Orca's Manual launch option means no bypass flag, not a forced Claude
permission mode.

### Launch warnings

Launchers display all warnings before starting the native UI and wait for one explicit acknowledgement.
Enter continues; Ctrl+C or Escape cancels. Warnings never expire automatically. Prepared Orca
resurrection commands use the same acknowledgement before executing the native process. A noninteractive launch cannot
acknowledge warnings; use `mpx launch-preview pi personal` to inspect without starting a session.

| Situation | Color |
| --- | --- |
| Personal account opening a work folder | Red |
| Work account opening a personal folder | Orange |
| Folder outside recognized account domains | Yellow |
| Missing project configuration | Yellow |
| Invalid or unreadable project configuration | Orange |
| Git project discovery failed | Orange |
| Requested packs unavailable, or fallback packs unavailable | Orange |

Domain checks consider the current directory and the Git main checkout, including resolved filesystem
links. A work location takes precedence when a worktree and its main checkout have different ownership.
Warnings do not switch accounts or prohibit a launch after acknowledgement. Missing executables or
unusable account configuration can still prevent startup.

### Machine-local project configuration

For repositories where committing MPX metadata is inappropriate, add a `projectOverrides` entry to
user configuration. These settings stay on the machine; no parent-directory `mpxconfig.json` is inherited.

```json
{
  "projectOverrides": [
    {
      "path": "${MPX_WORK}/example",
      "config": {
        "projectId": "example",
        "repository": { "provider": "gitlab", "remote": "origin" },
        "issues": { "provider": "kanbanflow", "metadata": { "boardId": "example" } }
      }
    },
    { "path": "${MPX_AI_GENERATED}", "omitConfig": true }
  ]
}
```

Use either `config` or `omitConfig: true`, not both. An existing repository manifest remains
authoritative, including its validation errors; a local entry cannot silently replace a broken file.
`omitConfig` explicitly accepts absent metadata, rather than inventing providers for an ordinary folder.
Repository entries match their Git main checkout, so linked worktrees share the same configuration.
An ordinary-folder entry can cover its subfolders but does not supply metadata to nested Git repositories.
Account domains still determine which account warnings appear. Git discovery failures do not grant
ordinary-folder fallback behavior to an unidentified repository. `mpx project config <directory>`
returns the same resolved metadata as the launcher, allowing workflows to use local overrides without
writing them into a repository.

Pi starts with the expanded operational footer and collapsed agent history. Click its disclosure arrow
in fullscreen mode, use `Ctrl+Alt+F`, or run `/footer` to toggle the single-line footer. That compact
line contains session, model, effort, context usage, and quota percentages with reset countdowns.
`/footer details` shows bounded finished-agent details; `/footer compact` collapses everything. Agent
names and the main model follow contrasting tier colors: Astra green, Sol blue, Luna yellow, and Terra orange. History groups agents
by model and effort, sorts priced groups by estimated cost
and unpriced groups by tokens, and omits unavailable prices. The live-agent widget disappears when idle.
Runtime sync disables the upstream widget and fleet view to avoid duplicate displays; project
`.pi/subagents.json` overrides should retain `"widgetMode": "off"` and `"fleetView": false`.

Both Claude accounts load the main and subagent status lines from
[`src/claude-statusline/`](src/claude-statusline/README.md). Their existing layout is retained without
legacy script links, credential-file reads, port-manager dependencies, or generated editor launchers.

## Development

Requirements: Node 22.20 or newer, pnpm, and Git Bash on Windows.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm run typecheck
pnpm test
pnpm status
```

Author canonical resources under `content/`, then run `pnpm build` from the repository root.
Keep retired skills in `content/skills/archived/` and incomplete skills in
`content/skills/unfinished/`; both trees are excluded from build validation and distribution.
Keep retired agents in `content/agents/archived/`, also excluded from build validation and distribution.
Use `{{include:relative/path.md}}` for build-time instruction inclusion, resolved from the authored
file. Includes expand transitively; cycles and paths outside `content/` fail the build. Deferred
Markdown links remain references: the compiler bundles their transitive dependencies inside each
consuming skill and rewrites links locally. Keep operational agent instructions inline.

The compiler writes ignored, reproducible projections under `dist/`; do not edit or commit them.
Build after a fresh checkout and after content changes before launching a harness or running tests.
Runtime code is under `src/`, native Pi adapters
are under `extensions/`, and migration/recovery utilities are under `migration/`.

Orca can prepare a worktree before dependencies are installed:

```bash
ORCA_ROOT_PATH=/path/to/root ORCA_WORKTREE_PATH=/path/to/worktree \
  node /path/to/mpx/scripts/prepare-worktree.mjs
```

The helper copies only missing files under `.vscode`, `.cursor`, and `.local`; these trees may contain
private configuration. Root-level environment files are excluded. It does not create worktrees,
install packages, configure permissions, allocate ports, or start servers.

## Ownership and safety

- **MPX:** canonical skills/instructions, account launchers, project metadata, native safeguards,
  formatting adapters, and native resume preparation.
- **Pi and Claude Code:** authentication, models, settings, packages, and transcripts.
- **Orca:** worktrees, terminals, development-server visibility, status, and desktop attention.

Synchronizing or project setup can write user/project resources. Preview first and preserve unrelated
native or project-authored files. Safeguards are accident prevention, not a security sandbox.

Durable design rationale is in [DECISIONS.md](DECISIONS.md). Current migration status and recovery are
in [migration/HANDOFF.md](migration/HANDOFF.md) and
[migration/ACCOUNT_ROLLOUT.md](migration/ACCOUNT_ROLLOUT.md).
