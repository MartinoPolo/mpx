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

## Pi footer

The launch row displays `pi (mpx) · mode:developer · skills:developer · gh · gh` (`piw (mpx)` for work identity). Mode and skill policy come independently from the resolved launch through `MPX_MODE` and `MPX_SKILL_POLICY`; changing either requires a new launch. No skill counts are displayed.

Provider badges follow repository-then-Issues order and are never collapsed, even when identical. Provider selection comes from the session workspace's validated configuration at launch, not from Git remotes: GitHub is `gh`, GitLab is `glab`, and KanbanFlow is `kf`. An absent Issue configuration displays `none`; unavailable or invalid configuration displays `?` for each unknown role. Relaunch to apply provider configuration changes. The worktree remains on its separate location line.

Footer hyperlinks open these destinations when available:

- Runtime identity: the MPX account configuration, not native Pi settings.
- Mode: the discovered project's `mpxconfig.json`.
- Skills: the active projection's compiled skills directory, not the source checkout or a history of invoked skills.
- Repository: GitHub pull requests or GitLab merge requests, using the configured repository remote.
- Issues: the corresponding GitHub/GitLab issue list, or the explicitly configured KanbanFlow board.

Missing or unsafe destinations remain unlinked. Local directory projects do not acquire an inferred repository or issue tracker. Links use terminal hyperlinks; opening them depends on the terminal and local file associations.

## Executors

Windows host execution is an elevated compatibility path, not isolation. Manual use requires explicit host selection, a reason, and fresh direct-TTY or exact argv-scoped approval. Installed aliases provide the bounded one-use approval expected by their managed launch contract.

Docker execution is unavailable. Launch and resume fail with `EXECUTOR_UNAVAILABLE` before projection or process execution and never fall back to host.

## Integrity and privacy

Before spawning, MPX publishes and revalidates the exact runtime projection and executor evidence. Public descriptors, banners, audits, and errors omit credentials, native session data, private roots, command output, and file contents.

Claude checks projection integrity at its earliest supported hook boundaries. Pi binds the manifest to launch context and revalidates canonical skill files when loaded. Session continuation is handled by the separate [session lifecycle](SESSIONS_INSTALLER.md).

## Error guidance

Human CLI errors include possible solutions and explanations; see [error guidance](ERRORS.md) for working without project configuration and choosing a mode. Suggestions do not bypass approvals or ownership checks. `--json` retains its existing contract, and native runtime and gateway protocols retain their own error presentation.
