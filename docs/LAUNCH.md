# Launch

Use `mpx launch claude|pi` or an installed alias:

| Alias     | Runtime | Identity   |
| --------- | ------- | ---------- |
| `cc-mpx`  | Claude  | `personal` |
| `ccw-mpx` | Claude  | `work`     |
| `pi-mpx`  | Pi      | `personal` |
| `piw-mpx` | Pi      | `work`     |

Identity is always explicit, including through aliases. Working-directory classification never selects an identity or grants access. Native launchers remain untouched.

## Resolution

Launch resolves configuration, content scope, skill policy, runtime profile, workspace, network policy, and executor into an immutable descriptor and compiled projection. A changed binding, policy, artifact, or permission requires a new launch.

Repeatable `--runtime-arg <value>` arguments are launch-only, bounded, and appended after runtime-owned arguments. They cannot come from durable configuration or environment variables.

The selected runtime receives only its native account root: `CLAUDE_CONFIG_DIR` or `PI_CODING_AGENT_DIR`. MPX does not read or copy credentials. Native provider authentication and project trust remain runtime-owned.

## Executors

Windows host execution is an elevated compatibility path, not isolation. Manual use requires explicit host selection, a reason, and fresh direct-TTY or exact argv-scoped approval. Installed aliases provide the bounded one-use approval expected by their managed launch contract.

Docker execution is unavailable. Launch and resume fail with `EXECUTOR_UNAVAILABLE` before projection or process execution and never fall back to host.

## Integrity and privacy

Before spawning, MPX publishes and revalidates the exact runtime projection and executor evidence. Public descriptors, banners, audits, and errors omit credentials, native session data, private roots, command output, and file contents.

Claude checks projection integrity at its earliest supported hook boundaries. Pi binds the manifest to launch context and revalidates canonical skill files when loaded. Session continuation is handled by the separate [session lifecycle](SESSIONS_INSTALLER.md).
