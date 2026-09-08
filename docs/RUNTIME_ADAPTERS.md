# Runtime adapters

MPX compiles canonical content before runtime assembly. Adapters consume the verified compiled tree and own only native projection assets, invocation arguments, and runtime lifecycle wiring.

## Shared boundaries

- `content/runtime-profiles.json` maps semantic model classes, capabilities, aliases, and supported frontmatter to each runtime.
- Compiler-owned skill and agent bytes are copied unchanged.
- Private account roots are passed only to the selected runtime.
- Releases and public launch data contain no credentials, native sessions, or private file contents.
- Dangerous-command policy is shared; runtime event translation and process execution remain adapter-owned.

## Pi

Canonical Pi-specific implementation lives under `runtimes/pi/extensions` and is loaded once through native package discovery. The adapter does not generate substitute footer, tool, hook, command, editor, widget, configuration, keybinding, or theme implementations.

The adapter passes `PI_CODING_AGENT_DIR`, compiled agents, launch context, and a manifest integrity binding. The native extension registers compiler-managed skills as `/mpx:<name>` and lazily revalidates their files before loading bodies.

Project skills are classified before launch:

- explicit MPX metadata opts a skill into managed compilation and strict exposure policy;
- native skills retain Pi interpretation and `/skill:<name>`;
- ambiguous ownership, unsafe YAML indirection, path escape, or changed files fail closed.

The adapter keeps ambient broad skill discovery disabled and supplies only exact validated project entrypoints. Native extension and agent discovery otherwise retain Pi-owned precedence and trust behavior.

Pi lifecycle integration tracks only the original MPX launch-bound native session. It queues startup events until a matching native session header exists, never creates or rewrites native session files, and stops claiming ownership after a successful native session replacement.

Completion notifications are owned by the native extension. User-origin TUI or RPC requests may notify after `agent_settled` and queued continuations drain; headless subagents, print/JSON sessions, idle menus, cancellation, reload, and shutdown do not. Windows uses `%WINDIR%/Media/tada.wav`; mute controls suppress sound and taskbar flashing.

## Claude

Claude receives an immutable plugin projection with compiled skills and agents, hooks, status support, runtime context, and plugin metadata. `CLAUDE_CONFIG_DIR` selects the native account root.

Claude represents `name-only` with a neutral description and `explicit-only` with `disable-model-invocation`. Integrity checks run at the earliest supported native boundaries, but they are not an atomic interceptor around Claude's own skill-file read.

## Host environment

Host launches preserve `ProgramData` for Windows OpenSSH. Dropping it can make `ssh.exe` and
`ssh-add.exe` exit before diagnostic output, including for a local version check. Preserve this OS
path without forwarding ambient SSH command overrides or authentication-agent settings through the
launch environment allowlist.

## Executor status

Windows host execution is the accepted compatibility path and is not isolation. Whole-agent Docker execution is unavailable: launch and resume fail with `EXECUTOR_UNAVAILABLE` and never fall back to host. Session continuation belongs to the lifecycle/session layer, not projection generation.
