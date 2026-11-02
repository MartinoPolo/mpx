---
name: project-register
description:
  'Registers an existing project with the workstation — one colour driving its Windows Terminal
  profile...'
metadata:
  author: MartinoPolo
  version: '0.8'
  category: setup
  mpx:
    schemaVersion: 1
    skillPacks: [personal]
    defaultExposure: explicit-only
---

# Register a project with the workstation

Give a project one colour and one icon, then wire both into every surface that opens it. The project
comes from the invocation input.

This registers a project that already exists on disk, whether or not it has a Git repository.
Existing repositories are preserved; registration never initializes or publishes one.

Follow-up skills below use their native commands. They run only when selected and available in the
active pack.

Scripts live in `./scripts/`:

| Script             | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `wt-profile.mjs`   | `colors`, `icons-dir`, `add` a Windows Terminal profile     |
| `orca-project.mjs` | `groups`, `apply` icon, colour and group to an Orca project |
| `make-icon.py`     | Render the 256×256 profile icon                             |

## Process

1. Gate on the Raycast export
2. Resolve the project
3. Validate or create user-owned `mpxconfig.json` metadata
4. Choose the colour
5. Draw the icon
6. Add the Windows Terminal profile
7. Register the project in Orca
8. Hand quicklinks to `raycast-config`
9. Optionally register the project in the Obsidian task overview
10. Offer the remaining setup skill

### Step 1: Gate on the Raycast export

Before changing another surface, tell the user: **Raycast → `Ctrl+,` → Advanced → Export Settings &
Data**, choose a passphrase of 8+ characters, and save to Desktop. Resolve the home directory from
the environment. Find `Raycast-*.rayconfig` candidates under Desktop and Downloads, offer the newest
with modified times, and also offer an explicit Raycast skip. Carry a current selected export to
step 8; if it predates this session's work, request a fresh export.

### Step 2: Resolve the project

Resolve only `MPX_PROJECTS` and `MPX_WORK` from the process environment — written in prose they are literal
text, not paths to search. Take the folder from `the invocation input`. A bare name is resolved
against the machine roots `MPX_PROJECTS` then `MPX_WORK`; confirm the match when both contain it.
Fail with the variable's name when neither resolves.

Report what is already registered, so a re-run repairs rather than duplicates:

```bash
node "./scripts/wt-profile.mjs" colors
```

### Step 3: Validate or create user-owned MPX metadata

For a Git repository, manage `<project>/mpxconfig.json` as user-owned metadata. If it exists,
parse it and require exactly this native schema before changing another field: `projectId`;
`repository: { provider, remote }`; `issues: { provider, metadata? }`; and optional
`packageManager` and `packs`. Repository providers are independently one of GitHub, GitLab, or
Gerrit. Issue providers are independently GitHub or KanbanFlow; local Issues are unsupported.
Malformed or unknown fields block this branch and remain untouched.

When the file is missing, gather and confirm the complete values. Propose the folder name as
`projectId`; require an explicit repository provider and remote; require an independent Issue
provider and its target metadata (for KanbanFlow, `boardId` and optional `boardName`; for GitHub,
the explicit Issue repository when it differs); detect a package manager only from repository files;
and ask for selected packs only when the user wants to replace wrapper defaults. Show the complete
JSON before writing it. Write only after confirmation, preserve an explicit empty `packs: []`,
then parse the written file again and report its path and values. Never add credentials, account
routing, workspace/session state, ports, or Orca settings.

A folder without Git may still receive the desktop integrations below, but it cannot receive valid
repository metadata. Record MPX metadata as pending rather than inventing a provider or initializing
or publishing a repository.

### Step 4: Choose the colour

One colour drives the Windows Terminal tab, the Orca project, the Obsidian tag and the icon plate,
so the project reads the same everywhere.

Propose a colour that fits what the project _is_ — read its `README.md` for the domain rather than
reaching for the next unused hue. Check it against the colours from step 2 and pick again when it is
close enough to an existing one to be confused at a glance; neighbouring shades of the same hue are
the common trap.

Confirm the choice with the native structured question UI, offering the suggestion plus two alternatives.

### Step 5: Draw the icon

Icons live beside the Windows Terminal settings — `node "./scripts/wt-profile.mjs" icons-dir` prints
the folder. Render to the unique session scratch directory first, **show it to the user with the
native image-reading capability**, and copy it
into that folder only once they accept it. `make-icon.py` refuses to overwrite an existing file, so
a rejected draft is written under a new name.

A glyph covers most projects:

```bash
python "./scripts/make-icon.py" --color '#0F766E' \
  --glyph 'π' --font cambriab.ttf --glyph-scale 0.78 --out '<scratchpad>/<project>.png'
```

When no character carries the meaning, write a motif file defining
`draw_motif(draw, size, ink, plate)` — Pillow drawing calls on a plate already filled, with `size`
the supersampled canvas — and pass `--motif <file>`. Keep the shape readable at 16px: solid
silhouettes, few parts, no thin outlines.

### Step 6: Add the Windows Terminal profile

```bash
node "./scripts/wt-profile.mjs" add \
  --name '<project>' --dir '<project path>' --icon '<icons dir>/<project>.png' --color '#RRGGBB'
```

Require an absolute `MPX_AI_DUMP` before adding a profile. The script backs the settings file up in a
unique folder under `MPX_AI_DUMP/_PROJECT_REGISTER/` and aborts if the backup fails. It copies the
shell commandline from the profiles already there, generates the GUID, and re-parses the result
before writing, so a malformed edit never reaches Windows Terminal. Report the returned backup path.
Windows Terminal picks the profile up on its own — no restart.

Keep the profile name identical to the folder name for predictable terminal automation.

The new-tab dropdown is a grouped `newTabMenu` in the same settings file — general shells, mpx
tooling, work repositories, a `remainingProfiles` catch-all, then admin shells, with `separator`
entries between groups. A freshly added profile lands in the catch-all until its GUID is placed
explicitly. Use the native structured question UI to ask which group the project belongs to (mpx
tooling, work repositories, or leave it in the catch-all), then edit the settings file to insert
`{ "type": "profile", "profile": "<guid>" }` at the end of the chosen group. Two rules the menu
depends on: keep every GUID comment-free JSON (Windows Terminal rejects trailing commas), and
remember that the `ctrl+shift+<digit>` bindings target dropdown _positions_ — inserting into a group
above the work section shifts every number below it, so tell the user when the numbering moves.

### Step 7: Register the project in Orca

Add the project with the Orca CLI (forward-slash path), then set its icon, colour and group through
the running Orca runtime; the CLI cannot set those, and Orca overwrites external edits to its data
file. Orca must be running.

```bash
orca repo add --path '<project path>' --json
node "./scripts/orca-project.mjs" groups
node "./scripts/orca-project.mjs" apply --path '<project path>' \
  --icon '<icons dir>/<project>.png' --color '#RRGGBB' --group '<Parent › Group>'
```

Ask which group the project belongs to with the native structured question UI, offering the paths
`groups` prints. `apply` prints the stored record; confirm the group id, colour and `image:upload`
icon there.

### Step 8: Hand quicklinks to `raycast-config`

Propose a quicklink family, then resolve and read `../{{MPX_SKILL_PREFIX}}raycast-config/SKILL.md` and its referenced
material. Carry out that skill in this conversation using the export (or skip) from step 1. It owns
the export format, identifiers, aliases, and import wording. Inputs are: folder = project path;
term = `wt -p "<profile name>"`; and remote
links are resolved independently: **repo** and **reviews/PRs** come from the selected repository
provider's native guide, while **issues** comes from the selected Issue provider's native guide.
Include only links each provider actually exposes when the corresponding repository or project
exists. When the folder has no repository, omit repo and reviews/PR quicklinks; do not initialize or
publish a repository. If a provider cannot return a browser URL, omit that quicklink and record a
manual handoff; do not derive Issue URLs from repository URLs, conflate PR/MR and Issue routes, or
invent provider commands. Batch multiple projects before the import round-trip when appropriate.

### Step 9: Register the project in the Obsidian task overview

Resolve `MPX_OBSIDIAN_VAULT` from the environment. When it identifies a vault the user uses, read
[OBSIDIAN_REGISTRATION.md](OBSIDIAN_REGISTRATION.md) and follow that branch. Do not infer or
reconstruct the vault root from a home or sync-directory path. When the variable is unavailable or
the user keeps no such vault, skip this surface and record why.

### Step 10: Offer the remaining setup skill

When it applies, offer `{{MPX_SKILL_COMMAND}}design-init` (palette, fonts, `designs/tokens.css`);
it runs only if chosen.

If the user picks it, invoke its public command and carry out its steps in this conversation. If
the selected command is unavailable, ask the user to include the `development` pack; never load an
excluded `SKILL.md` directly, silently skip a selected follow-up, or broaden the selected packs
automatically.

## Report

Close with a table of surfaces touched — Windows Terminal, `mpxconfig.json`, Orca, Raycast, and Obsidian `Tasks.md` — each with the file written and the value used. Name the Windows
Terminal backup path, and state plainly which steps were skipped and why.
