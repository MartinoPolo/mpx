---
name: symlink
description:
  'Creates and verifies Windows symlinks and directory junctions through PowerShell New-Item. Any
  symlink...'
metadata:
  author: MartinoPolo
  version: '0.1.3'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Windows Symlinks & Junctions

Create and verify links that survive Git and resolve everywhere on this Windows machine.

**The one rule:** In the active runtime, create links by invoking **PowerShell from public Git Bash** (`powershell.exe ... New-Item`). Git
Bash `ln -s` copies the target instead of linking (`core.symlinks=false`), and
`cmd.exe //c "mklink ..."` through Git Bash fails with "syntax is incorrect" (quote mangling).

If the invocation input supplies a link path and a target, resolve both paths, detect the type
(target is a directory → junction, a file → symlink), and run Step 3 directly. Otherwise treat this
as the how-to reference below.

For paths outside the working directory, use the supplied machine-root environment variables
(`MPX_PROJECTS`, `MPX_WORK`, `MPX_CLONED`, `MPX_APPS`, `MPX_ONEDRIVE`, `MPX_AI_GENERATED`,
`MPX_AI_DUMP`, `MPX_TEMP`, or `MPX_OBSIDIAN_VAULT`) and join the requested relative path beneath the appropriate root. Verify the
selected variable is set and the target exists before creating anything. If the root is missing, the
requested path cannot be placed beneath an explicit root, or multiple roots plausibly match, stop
and ask for the exact root; never guess a drive, profile directory, or legacy installation path.
Echo the resolved link and target paths and ask for confirmation before replacing any existing
filesystem entry.

## Step 1: Pick the link type

| Target    | Type     | Command                           | Admin? |
| --------- | -------- | --------------------------------- | ------ |
| Directory | Junction | `New-Item -ItemType Junction`     | No     |
| File      | Symlink  | `New-Item -ItemType SymbolicLink` | Yes\*  |

\* File symlinks need **Developer Mode** on (Settings → Privacy & security → For developers) **or**
an elevated process. Junctions never need admin — prefer them for directories.

## Step 2: One-time git prerequisite

Git for Windows defaults to `core.symlinks=false`, which rewrites real symlinks into plain text
files on `checkout`/`clone`/`merge`. Enable once per machine:

```bash
git config --global core.symlinks true
```

## Step 3: Create the link through Git Bash

Directory junction (no admin):

```bash
powershell.exe -NoProfile -NonInteractive -Command "New-Item -ItemType Junction -Path 'C:\link\path\name' -Target 'C:\repo\real\dir' | Out-Null"
```

File symlink (Developer Mode or elevated):

```bash
powershell.exe -NoProfile -NonInteractive -Command "New-Item -ItemType SymbolicLink -Path 'C:\link\path\file.md' -Target 'C:\repo\real\file.md' | Out-Null"
```

Make it idempotent — guard before creating so a re-run skips silently. Do not treat an existing
wrong link or ordinary file as success; inspect it and stop for approval before replacement:

```powershell
if (-not (Test-Path -LiteralPath "C:\link\path\file.md")) {
    New-Item -ItemType SymbolicLink `
        -Path "C:\link\path\file.md" `
        -Target "C:\repo\real\file.md"
}
```

If a file symlink throws "You do not have sufficient privilege" (no Developer Mode), retry that
single op elevated — accept the UAC prompt:

```powershell
$mk = "New-Item -ItemType SymbolicLink -Path 'C:\link\path\file.md' -Target 'C:\repo\real\file.md' | Out-Null"
Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden `
    -ArgumentList '-NoProfile','-NonInteractive','-Command',$mk
```

## Step 4: Verify

```powershell
Get-ChildItem "C:\link\path" | Format-Table Name, LinkType, Target -AutoSize
```

- `LinkType` = `SymbolicLink` or `Junction` and `Target` = where it resolves → the link is real.
- A plain file here (blank `LinkType`) means it was **copied, not linked** — delete it and recreate
  through the reviewed PowerShell command.
- In Git Bash, `ls -la "C:/link/path"` shows `->` arrows for real links.

Confirm the link resolves to real content:

```powershell
Test-Path "C:\link\path\name"   # True → target reachable through the link
```

## Removing links

- **Directory junction:** `(Get-Item "C:\link\path\name").Delete()` — removes the link only. Never
  `Remove-Item -Recurse` on a junction; PowerShell 5.1 can follow it and delete the target's
  contents.
- **File symlink:** `Remove-Item "C:\link\path\file.md"` (or Git Bash `rm`).
