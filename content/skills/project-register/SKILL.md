---
name: project-register
description: 'Registers an existing project with the workstation — one colour driving its Windows Terminal profile and icon and its VS Code Peacock theme.'
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [personal]
    defaultExposure: explicit-only
---

# Register a project with the workstation

Give a project one colour and one icon, then wire both into every surface that opens
it. The project comes from the invocation input.

This registers a project that already exists on disk. If it has no git repo yet, step 2
initializes one automatically — see that step for what it covers and where it still stops
to ask.

Skills referenced below (`repository-setup`, `board-setup`) are
read-and-follow, per the global "Cross-skill references" rule in `instructions/AGENTS.md`.

Scripts live in `./scripts/`:

| Script           | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `wt-profile.mjs` | `colors`, `icons-dir`, `add` a Windows Terminal profile             |
| `peacock.mjs`    | `used` colours across projects, `write` a project's `peacock.color` |
| `make-icon.py`   | Render the 256×256 profile icon                                     |

## Process

1. Resolve the project
2. Initialize the repo if needed
3. Choose the colour
4. Draw the icon
5. Add the Windows Terminal profile
6. Write the VS Code Peacock block
7. Optionally register the project in the Obsidian task overview
8. Offer the remaining setup skills

### Step 1: Resolve the project

Resolve `MPX_PROJECTS` and `MPX_WORK` with `env | grep '^MPX_'` — written in prose they are
literal text, not paths to search. Take the folder from `the invocation input`. A bare name is
resolved against the machine roots `MPX_PROJECTS` then `MPX_WORK`; confirm the match when
both contain it. Fail with the variable's name when neither resolves.

Report what is already registered, so a re-run repairs rather than duplicates:

```bash
node "./scripts/wt-profile.mjs" colors
node "./scripts/peacock.mjs" used
ls "<project>/.vscode/settings.json"
```

### Step 2: Initialize the repo if needed

Check `git -C "<project>" rev-parse --git-dir`. When the project has no repository, read
[REPOSITORY_INIT.md](REPOSITORY_INIT.md) and follow that branch. It invokes the canonical
`repository-setup` skill and preserves its confirmation gates. When the check succeeds,
preserve the existing repository and continue.

### Step 3: Choose the colour

One colour drives the Windows Terminal tab, the VS Code chrome and the icon plate, so the
project reads the same in every window.

Propose a colour that fits what the project _is_ — read its `README.md` for the domain
rather than reaching for the next unused hue. Check it against both lists from step 1 and
pick again when it is close enough to an existing one to be confused at a glance;
neighbouring shades of the same hue are the common trap.

Confirm the choice with `AskUserQuestion`, offering the suggestion plus two alternatives.

### Step 4: Draw the icon

Icons live beside the Windows Terminal settings — `node "./scripts/wt-profile.mjs" icons-dir`
prints the folder. Render to the session scratchpad first, **show it to the user with
`Read`**, and copy it into that folder only once they accept it. `make-icon.py` refuses to
overwrite an existing file, so a rejected draft is written under a new name.

A glyph covers most projects:

```bash
python "./scripts/make-icon.py" --color '#0F766E' \
  --glyph 'π' --font cambriab.ttf --glyph-scale 0.78 --out '<scratchpad>/<project>.png'
```

When no character carries the meaning, write a motif file defining
`draw_motif(draw, size, ink, plate)` — Pillow drawing calls on a plate already filled,
with `size` the supersampled canvas — and pass `--motif <file>`. Keep the shape readable
at 16px: solid silhouettes, few parts, no thin outlines.

### Step 5: Add the Windows Terminal profile

```bash
node "./scripts/wt-profile.mjs" add \
  --name '<project>' --dir '<project path>' --icon '<icons dir>/<project>.png' --color '#RRGGBB'
```

The script backs the settings file up beside itself, copies the shell commandline from the
profiles already there, generates the GUID, and re-parses the result before writing, so a
malformed edit never reaches Windows Terminal. Report the backup path. Windows Terminal
picks the profile up on its own — no restart.

Keep the profile name identical to the folder name for predictable terminal automation.

The new-tab dropdown is a grouped `newTabMenu` in the same settings file — general shells,
mpx tooling, work repositories, a `remainingProfiles` catch-all, then admin shells, with
`separator` entries between groups. A freshly added profile lands in the catch-all until its
GUID is placed explicitly. Use `AskUserQuestion` to ask which group the project belongs to
(mpx tooling, work repositories, or leave it in the catch-all), then `Edit` the settings
file to insert `{ "type": "profile", "profile": "<guid>" }` at the end of the chosen group.
Two rules the menu depends on: keep every GUID comment-free JSON (Windows Terminal rejects
trailing commas), and remember that the `ctrl+shift+<digit>` bindings target dropdown
_positions_ — inserting into a group above the work section shifts every number below it,
so tell the user when the numbering moves.

### Step 6: Write the VS Code Peacock colour

```bash
node "./scripts/peacock.mjs" write '<project path>' '#RRGGBB'
```

This merges into any existing `.vscode/settings.json` and writes **only** `peacock.color`,
set to the same value as the tab, which is what makes the two windows match. One property is
the single source of truth: Peacock regenerates the activity bar, status bar, title bar and
badge colours itself the first time VS Code opens the folder. Any stale derived keys left in
`workbench.colorCustomizations` by an earlier colour are cleared in the same write.

### Step 7: Register the project in the Obsidian task overview

Resolve `MPX_OBSIDIAN_VAULT` from the environment. When it identifies a vault the user
uses, read [OBSIDIAN_REGISTRATION.md](OBSIDIAN_REGISTRATION.md) and follow that branch.
Do not infer or reconstruct the vault root from a home or sync-directory path. When the
variable is unavailable or the user keeps no such vault, skip this surface and record why.

### Step 8: Offer the remaining setup skills

`repository-setup` is no longer in this list — step 2 already ran it if the project needed it.
Name the ones that still apply and let the user pick — neither runs unless chosen:

- [`board-setup`](../board-setup/SKILL.md) — Obsidian board and its `BOARD.md` symlink
- [`design-init`](../design-init/SKILL.md) — palette, fonts, `designs/tokens.css`

If the user picks one, read its `SKILL.md` and carry out its steps yourself in this
conversation — this applies to `design-init` too for consistency even though its
invocation isn't blocked.

## Report

Close with a table of surfaces touched — Windows Terminal, VS Code and Obsidian
`Tasks.md` — each with the file written and the value used. Name the Windows Terminal backup path, and
state plainly which steps were skipped and why.
