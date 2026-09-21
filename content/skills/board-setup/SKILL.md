---
name: board-setup
description:
  'Sets up an Obsidian board for the project and links it into the repo through a BOARD.md symlink.'
metadata:
  author: MartinoPolo
  version: '0.4'
  category: setup
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# board-setup

One-time setup that creates this project's Obsidian **board** and links it into the repo, so
`board-to-issues` and `batch-execute` can read requirements and pasted images.

## Step 1: Resolve paths

- **Repo root** — `git rev-parse --show-toplevel` for the current checkout.
- **Project and board identity** — resolve `mpxconfig.json` from the Git main checkout. Only when the manifest is
  absent may a matching explicit machine-local project override supply the same fields; do not
  search parent directories for another manifest. Stop when configuration is missing, invalid, or
  lacks a required field. Use `projectId` as the canonical project identity. When `issues.provider`
  is `kanbanflow`, require `issues.metadata.boardId` and use optional `issues.metadata.boardName`;
  never infer a board
  from the repository name or account defaults. For the Obsidian filename, use `boardName` when
  present, otherwise the final segment of `projectId`.
- **Vault root** — the `[vault-root]` argument if given; else resolve `MPX_OBSIDIAN_VAULT` from the
  environment; else ask the user for the absolute Obsidian vault path (and suggest they set
  `MPX_OBSIDIAN_VAULT` so future projects skip this prompt). Never guess a machine path.

## Step 2: Create board + links

Resolve the bundled script directory, then run the setup script through public Git Bash:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>/scripts/link-board.ps1" -Repo "<repo>" -Vault "<vault>" -Project "<project>"
```

The script is idempotent and:

- enables `core.symlinks` in this repository's local Git configuration so Windows preserves real
  symlinks without changing global settings;
- creates `<vault>\Boards\<project>.md` with the four-lane skeleton (`# To Process`,
  `# Ready to implement`, `# Manual testing`, `# Archive`) **only if it does not already exist**
  (never clobbers existing notes);
- creates the `.mpx/board-files` junction → `<vault>\Files` (no admin) and the `.mpx/BOARD.md` file
  symlink → the board;
- appends `.mpx/BOARD.md` and `.mpx/board-files/` to `.gitignore`, inserting a line break first when
  the existing file has no final newline.

Both links are per-machine and gitignored. The lanes are the workflow state: unchecked top-level
notes enter `# To Process`; `# Ready to implement` means a provider Issue exists;
`# Manual testing` means implemented, awaiting manual
testing. Only the user moves verified work to `# Archive`. The checkbox belongs to the user, and
workflows leave it unchanged.

Without Windows Developer Mode the direct symlink call fails; the script then retries that single op
in an elevated child process (`Start-Process -Verb RunAs`), which raises a UAC prompt. Tell the user
to accept it.

## Step 3: Verify + report

Confirm the script printed both links. If it still warned that the `.mpx/BOARD.md` symlink could not
be created (elevation declined, or the UAC prompt wasn't accepted), the junction and board file are
already in place — only the file symlink needs the extra privilege. Re-run the script and accept the
UAC prompt, or enable Windows Developer Mode (Settings › Privacy & security › For developers) and
re-run.

Report the board path, both link paths, and the next step: **open the board in Obsidian, paste any
bug/task/feature notes with screenshots under `# To Process` (no need to sort by type), then run
`{{MPX_SKILL_COMMAND}}board-to-issues` or `{{MPX_SKILL_COMMAND}}batch-execute`.** If symlink privilege remains unresolved, report
partial success rather than full completion.
