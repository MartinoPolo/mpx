# React Native Setup Platform Reference

## Framework rule link

The source is the projected `rules/projects/react.md` beneath the active MPX2 content root. Resolve
it through [CONTENT_PATHS](../../../../../pi/instructions/shared/CONTENT_PATHS.md). Do not probe guessed checkout locations. Destination:
`<project-path>/.claude/rules/react.md`.

Create the parent directory first:

```bash
mkdir -p <project-path>/.claude/rules
```

### Linux and macOS

```bash
ln -s "<resolved-react-rule>" "<project-path>/.claude/rules/react.md"
```

### Windows

Git Bash `ln -s` may create a copied or emulated link. Create a real file symbolic link:

```bat
cmd.exe /c mklink "<project-path>\.claude\rules\react.md" "<resolved-react-rule>"
```

If permission is denied, recommend Windows Developer Mode or an elevated terminal and provide the
exact resolved command. Continue without copying the mutable central rule while claiming it is
linked.

Verify that the destination is a symbolic link and resolves to the expected source.

## Failure handling

| Problem                   | Outcome                                                   |
| ------------------------- | --------------------------------------------------------- |
| Template absent           | Name the expected account/template and stop               |
| Repository creation fails | Preserve native provider error and stop                   |
| Default branch fails      | Preserve pushed branches; manual handoff                  |
| Protection fails          | Record complete error and branch as unprotected; continue |
| Install/check fails       | Record command/output and impact; continue only if viable |
| Rule link fails           | Record exact manual command; continue                     |
| Push fails                | Preserve local commits and report remediation             |

Always use pnpm and `git -C <project-path>`. Never print credentials or unrelated private paths.
