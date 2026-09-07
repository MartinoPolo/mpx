---
name: board-setup
description: 'Sets up an Obsidian board for the project and links it into the repo through a BOARD.md symlink.'
metadata:
  author: MartinoPolo
  version: '0.4'
  category: setup
  mpx:
    schemaVersion: 1
    skillPacks: [personal]
    defaultExposure: explicit-only
---

# board-setup

One-time setup that creates this project's Obsidian **board** and links it into the repo, so `board-to-issues` and
`batch-execute` can read requirements and pasted images. Read [Board Convention](../shared/BOARD_CONVENTION.md) now.
Resolve linked files relative to this loaded skill. For absolute reads, follow
[Content Paths](../shared/CONTENT_PATHS.md).

## Step 1: Resolve paths

- **Repo root** — `git rev-parse --show-toplevel`.
- **Project and board identity** — read the nearest valid `mpxconfig.json`; use `project.id` as the canonical project
  identity. When `issues.provider` is `kanbanflow`, use its required `boardId` and optional `boardName` as the board
  selection; never infer a board from the repository name or account defaults. For the Obsidian filename, use
  `boardName` when present, otherwise the final segment of `project.id`. Stop if required configuration is missing or
  ambiguous.
- **Vault root** — the `[vault-root]` argument if given; else resolve `MPX_OBSIDIAN_VAULT` from the environment; else
  ask the user for the absolute Obsidian vault path (and suggest they set `MPX_OBSIDIAN_VAULT` so future projects skip
  this prompt). Never guess a machine path.

## Step 2: Create board + links

Run the setup script with the resolved paths (PowerShell tool):

```powershell
& "./scripts/link-board.ps1" -Repo "<repo>" -Vault "<vault>" -Project "<project>"
```

The script is idempotent and:

- enables `core.symlinks` in this repository's local Git configuration so Windows preserves real symlinks without
  changing global settings;
- creates `<vault>\Boards\<project>.md` with the four-lane skeleton (`# To Process`, `# Ready to implement`,
  `# Manual testing`, `# Archive`) **only if it does not already exist** (never clobbers existing notes);
- creates the `.mpx/board-files` junction → `<vault>\Files` (no admin) and the `.mpx/BOARD.md` file symlink → the board;
- appends `.mpx/BOARD.md` and `.mpx/board-files/` to `.gitignore`, inserting a line break first when the existing file
  has no final newline.

Without Windows Developer Mode the direct symlink call fails; the script then retries that single op in an elevated
child process (`Start-Process -Verb RunAs`), which raises a UAC prompt. Tell the user to accept it.

## Step 3: Verify + report

Confirm the script printed both links. If it still warned that the `.mpx/BOARD.md` symlink could not be created
(elevation declined, or the UAC prompt wasn't accepted), the junction and board file are already in place — only the
file symlink needs the extra privilege. Re-run the script and accept the UAC prompt, or enable Windows Developer Mode
(Settings › Privacy & security › For developers) and re-run.

Report the board path, both link paths, and the next step: **open the board in Obsidian, paste any bug/task/feature
notes with screenshots under `# To Process` (no need to sort by type), then run `/mpx:board-to-issues` or
`/mpx:batch-execute`.** If symlink privilege remains unresolved, report partial success rather than full completion.
