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
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" resume --list` | List resumable native sessions |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" status` | Inspect MPX2 resources and conflicts |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" sync --preview` | Preview account-resource synchronization |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" sync --runtime-only --account personal --harness pi --preview` | Preview one account/harness runtime scope |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" sync --orca-hooks-only --harness pi --preview` | Preview only Orca-owned Pi extension mirroring |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" project setup --preview` | Preview optional project setup |
| `mpx project config <directory>` | Inspect `mpxconfig.json` or its local override |

Bare `mpx` and the account commands now use this checkout. Legacy recovery and suffixed launchers
are removed. PowerShell and the Windows `mpx.cmd` shim explicitly select Git Bash rather than the
Windows/WSL `bash` executable. Reopen existing terminals after migration to discard cached routing.

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

Author canonical resources under `content/`. The compiler writes committed projections under
`dist/`; do not edit generated projections directly. Runtime code is under `src/`, native Pi adapters
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
