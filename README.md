# MPX

MPX is the shared agent configuration for Pi and Claude Code. It provides account-aware launchers,
project-selected skill packs, native safeguards, session resume, and a deterministic Claude/Pi content
build. Native harnesses continue to own authentication, settings, packages, and conversation history.

## Daily commands

Run these from Git Bash:

| Command | Purpose |
| --- | --- |
| `pi` / `piw` | Start Pi with the personal / work account |
| `ccw` | Start Claude Code with the MPX work account |
| `cc` | Start the existing personal Claude route; MPX live acceptance is deferred |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" resume --list` | List resumable native sessions |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" status` | Inspect MPX2 resources and conflicts |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" sync --preview` | Preview account-resource synchronization |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" sync --orca-hooks-only --harness pi --preview` | Preview only Orca-owned Pi extension mirroring |
| `bash "$MPX_PROJECTS/mpx2/bin/mpx" project setup --preview` | Preview optional project setup |

`lpi`/`lpiw` and `lccw` temporarily retain direct recovery launch paths during migration. The
previously installed MPX `x*` launchers are no longer exposed. Until final command cutover, the bare
`mpx` command and personal `cc` still use the previous installation; use the checkout command above
for MPX2 management operations.

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

Repository and Issue providers are independent. Supported repository providers are GitHub, GitLab,
and Gerrit; supported Issue providers are GitHub and KanbanFlow. An explicit empty `packs` array
loads no MPX global packs while retaining native project and account resources. Linked worktrees use
the main checkout's configuration.

User configuration lives at `$APPDATA/mpx2/config.json` and maps personal/work Pi and Claude roots,
domain roots, optional default packs, and executable overrides. MPX never copies credentials or
conversation history between profiles.

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

The helper copies only missing `.vscode`, `.cursor`, and `.local` files. It does not create worktrees,
install packages, copy environment files, configure permissions, allocate ports, or start servers.

## Ownership and safety

- **MPX:** canonical skills/instructions, account launchers, project metadata, native safeguards,
  formatting adapters, and native resume preparation.
- **Pi and Claude Code:** authentication, models, settings, packages, and transcripts.
- **Orca:** worktrees, terminals, development-server visibility, status, and desktop attention.

Synchronizing or project setup can write user/project resources. Preview first and preserve unrelated
native or project-authored files. Safeguards are accident prevention, not a security sandbox.

Durable design rationale is in [DECISIONS.md](DECISIONS.md). Current migration status and recovery are
in [migration/PROGRESS.md](migration/PROGRESS.md) and
[migration/ACCOUNT_ROLLOUT.md](migration/ACCOUNT_ROLLOUT.md).
