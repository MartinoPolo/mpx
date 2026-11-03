# Obsidian registration branch

Read this branch only when `MPX_OBSIDIAN_VAULT` resolves to a vault the user uses.

## Procedure

1. Read one or two existing project notes `<vault>/_Projekty/<project>/<project>.md` as the format
   source: frontmatter `project`, `repo`, `github`, a links line, then `## Inbox`, `## Ideas`,
   `## Tasks`, `## Subprojects`. Create `<vault>/_Projekty/<folder-name>/<folder-name>.md` in that
   shape, with the project name equal to the repo folder name. An existing note is updated, never
   replaced; a note under `_Projekty/_Someday/` or `_Projekty/_Archive/` moves into its own folder.
2. Add the tag-pill rules to `<vault>/.obsidian/snippets/tagColors.css`, copying an existing
   project's variable line and selector rule with the colour chosen in Step 4.
3. Register the project in Task Genius (`.obsidian/plugins/obsidian-task-progress-bar/data.json`):
   a `pathMappings` entry, a `customProjects` entry with the same colour, and a `fileFilter` folder
   rule, each copied from an existing project. The file has case-colliding keys: never parse or
   re-serialise it. Edit it only by exact text insertion while Obsidian is closed, after copying a
   backup to `MPX_TEMP`. When Obsidian is running, leave this step to the user with the three
   snippets ready to paste.
4. Verify the note, both CSS rules and the three Task Genius entries each appear exactly once.

Skip this branch only when the user keeps no such vault, and record that reason in the final report.
