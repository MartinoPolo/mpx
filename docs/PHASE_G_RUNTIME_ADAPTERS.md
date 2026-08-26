# Phase G production branch runtime evidence

The session branch confirmation digest now binds the parent identity, canonical native-root digest, native binding, mode, executor, skill policy, content scope, workspace/network policy, grants, artifact key, and manifest key. Production apply reconstructs those axes through the ordinary launch resolver and execution service; the only branch-specific input is the verified native fork argv (`--resume <id> --fork-session` for Claude or `--fork <verified-file>` for Pi). No recursive `mpx` command or shell command string is used.

Root/account preflight and current Docker admission run before worktree, lease, terminal, lineage, or process effects. Runtime lifecycle events provide the actual native child identity used to finalize lineage. A modifying child's durable writer lease remains held until its launched process exits and is released on pre-launch failure.

Windows Terminal is optional. Its candidate must be an absolute, regular, non-symlinked `wt.exe` below a trusted machine root. Plans use `new-tab`, `--title`, `--startingDirectory`, `--`, and structured child argv; execution is explicitly `shell: false`. Missing or untrusted Terminal disables the tab feature and is reported by production adapter diagnostics. Spawn/process errors are not swallowed.

Automated evidence:

- `packages/sessions/src/branch.test.ts` — confirmation boundary, native fork argv, binding/admission ordering, lifecycle lineage, and active writer lease.
- `apps/cli/src/session-branch-adapters.test.ts` — ordinary-launch delegation, trusted `wt.exe` argv transport, no-shell execution, and availability diagnostics.
- `apps/cli/src/session-command.test.ts` — CLI plan/apply confirmation contract.

A live Windows Terminal side-by-side tab/UI observation remains a manual acceptance item; automation establishes argv and trust behavior only.
