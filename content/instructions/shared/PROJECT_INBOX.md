# Project Inbox

The intake for board notes is the project's Obsidian note. The provider Issue is the only tracker
after conversion; the note has no workflow lanes.

## Locate the note

Resolve `MPX_OBSIDIAN_VAULT` from the environment and the project name from the final segment of
`projectId` in `mpxconfig.json`. The note is `<vault>/_Projekty/<project>/<project>.md`; its
frontmatter `project:` must equal the project name. Stop and report when the variable, the
configuration, the note, or the match is missing or ambiguous; never guess a machine path.

## Collect items

Only unchecked top-level items beginning with `- [ ]` under `## Inbox` are eligible; ignore checked
and nested items and every other section. Capture each complete original item block, including
continuation lines and every `![[...]]` image wikilink. Resolve a wikilink by filename anywhere in the
vault, usually `Files/`, and ignore an optional display width such as `|639`. Read each image so its
visual context informs the work. Stop on a missing or ambiguous filename.

## Update items

Mark or delete an item only when the calling workflow says to, following the shared *Vault project
notes* rule. Marking changes only the checkbox on the item's first line to `[/]` and adds the link
there; find a marked item later by that link. Deleting removes exactly that complete original block.
Never reconstruct, reorder, or edit any other item, and leave image files in place. Re-read the note
first and stop if the block changed. Afterwards verify the edited block and that every untouched
item remains exactly once.
