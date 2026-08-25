# Board Convention

Shared convention for MPX's plain-markdown Obsidian board workflow. The board preserves visual
requirements that issue-provider APIs may not round-trip and can later create provider-neutral MPX
Issues.

## Link layout

| Repository path | Type | Target below `MPX_OBSIDIAN_VAULT` |
| --- | --- | --- |
| `.mpx/BOARD.md` | file symlink | `Boards/<project>.md` |
| `.mpx/board-files/` | directory link | `Files/` |

Both links are per-machine and gitignored. If an editor refuses to write through the file symlink,
resolve its real target and edit that file. A wikilink such as `![[Pasted image.png|639]]` contains
a filename, not a path; read the image through `.mpx/board-files/Pasted image.png` and ignore the
optional display width.

## Four-lane pipeline

```markdown
# To Process

# Ready to implement

# Manual testing

# Archive
```

| Lane | Meaning | Transition owner |
| --- | --- | --- |
| `To Process` | raw notes | user intake |
| `Ready to implement` | an MPX Issue exists | board-to-issues workflow |
| `Manual testing` | implemented, awaiting human verification | batch execution workflow |
| `Archive` | manually verified | user |

Every new note starts under `To Process`. Workflows move the original note; they do not delete or
retype it. Only unchecked top-level items in `To Process` are intake candidates. Other lanes are
never reprocessed.

## Item and issue reference format

```markdown
- [ ] The edit-name control should align with the name ![[Pasted image.png]]
```

An item may have continuation lines and multiple images. Conversion may combine related items into
one issue. Classify type from content: a defect is `bug`, a chore/audit/refactor is `task`, and a
new capability or improvement is `enhancement`. Submit labels semantically through the MPX Issue
contract and let the selected adapter map or reject them.

After issue creation, append the returned provider-neutral issue reference and move the item:

```markdown
# Ready to implement

- [ ] The edit-name control should align with the name ![[Pasted image.png]] → issue:142
```

Use `issue:<id>` as the canonical annotation; an adapter may display a provider-native reference in
its projection. Batch execution matches the item by this annotation, or by stable text identity in
board-direct mode.

## State is the lane, not the checkbox

Agents never change `- [ ]` to another marker. The checkbox belongs to the user and means manual
verification only. Implementation moves an unchanged item to `Manual testing`; the user checks it
and moves it to `Archive` after testing.
