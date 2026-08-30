# React Native Platform Reference

The generated monorepo contains `apps/web` (React), `apps/mobile` (Expo and React Native), `apps/api`, and shared `packages/shared`, `packages/ui`, and `packages/config`. Use pnpm and `git -C <project-path>` consistently.

## Framework rule link

Resolve the central React framework rule only from an authorized MPX content root or an explicit user-provided path. Destination: `<project-path>/.mpx/rules/react.md`.

- Linux/macOS: create a symbolic link with `ln -s <central-react-rule> <destination>`.
- Windows: create a real file symbolic link with `cmd.exe /c mklink "<destination>" "<central-react-rule>"`. Git-emulated links may copy instead. If permission is denied, recommend Developer Mode or an elevated terminal and provide the exact manual command.

Verify that the destination is a symbolic link resolving to the expected source. If linking fails, record the manual command and continue; never copy mutable central rules while claiming they remain linked.

## Failure handling

| Failure                                      | Outcome                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| Template absent or repository creation fails | Stop remote setup and report structured remediation.               |
| Default branch fails                         | Preserve pushed branches; report manual handoff.                   |
| Protection fails                             | Record full error and unprotected branch; continue.                |
| Install/check fails                          | Preserve command/output and continue only if setup remains viable. |
| Push fails                                   | Preserve local commits and report remediation.                     |

Never print credentials or private repository data in diagnostics. The final report records success or accepted exception for repository creation, default branch, both protection branches, checks, push, and framework rule link.
