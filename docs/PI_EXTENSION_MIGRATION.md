# Native Pi extension migration

This plan implements [ADR 0004](adr/0004-canonical-native-pi-extensions.md). `MPX_MIGRATION.md` remains the status and
evidence authority.

## Target ownership

```text
runtimes/pi/
  extensions/                    # @mpx/pi-extensions: canonical Pi-specific source
    package.json
    index.ts                     # static composition entrypoint
    footer.ts
    agent-resurrect.ts
    auto-title.ts
    compact-instructions.ts
    fullscreen-scroll-speed.ts
    guard-hooks.ts
    dev-server/
    subagents/
    terminal-progress/
    config/                       # checked-in Pi-specific settings/keybindings
    themes/
    test/
  runtime-pi/                    # thin launch/projection adapter
```

Move every retained Pi-specific implementation and its tests from the former `mpx-pi` repository into
`runtimes/pi/extensions`. Reconcile the existing vendored subagent copy into that package rather than retaining two
trees. Runtime-neutral skills and agents remain canonical under `content` and are projected for Claude and Pi.

Do not migrate generated legacy agents, machine-specific paths, dependency stores, caches, sessions, or retired scripts.
Move retained Pi-specific settings, keybindings, themes, and prompts as checked-in source rather than generating them;
keep runtime-neutral prompts under shared `content`. Replace hard-coded cross-repository imports with module-relative
imports owned by the new package. Keep runtime selection, model selection, identity binding, and session locations as
launch data rather than static extension configuration.

## Host parity

1. Migrate the canonical extension tree and its focused tests into MPX without changing behavior.
2. Replace generated Pi feature code with a static composition entrypoint from `@mpx/pi-extensions`. It may consume
   validated runtime context but must not be generated per launch.
3. Remove duplicate generated registrations before discovery is enabled: footer/editor ownership, `Agent`,
   `get_subagent_result`, `steer_subagent`, `dev_server`, fleet widgets, and overlapping guards must each have one
   implementation.
4. Install or link the canonical package into each selected native Pi account's discovery surface without replacing
   unrelated user extensions. Preserve native `pi` and `piw` launchers.
5. Remove `--no-extensions` and retire the explicit generated `--extension` argument in `planPiInvocation` and installed
   Pi registration. Keep `--no-skills` until skill discovery is addressed separately. The canonical package is activated
   once by discovery, never by both mechanisms.
6. Prove personal and work host launches, ordinary native discovery, trusted project discovery, `/reload`, complete
   footer behavior, subagents, development services, session resurrection, and unchanged native fallback.

## Cross-platform extension package

The host and sandbox use the same canonical TypeScript source. Pi-provided packages are peer dependencies; other runtime
modules are package dependencies. Packaging may compile or copy that source for a release, but may not create a second
implementation.

The portability seam is limited to environment and path translation:

- derive the account root from `PI_CODING_AGENT_DIR`;
- replace absolute former-repository imports with module-relative package imports;
- inject the project/ports configuration location;
- map `/workspace` and sandbox session paths to host-visible private paths for links;
- keep rendering, quota requests, Git collection, `gh`/`glab`, localhost probes, compaction, subagent events, and
  development-service events in the native extension.

## Windows notifications

See [Pi notification repair](PI_NOTIFICATION_REPAIR.md) for incident attribution, deployed source provenance,
verification, and the boundary with the unfinished broader migration.

The canonical notification policy is `runtimes/pi/extensions/notifications.ts`, registered by `guard-hooks.ts`. A human
prompt arms the main TUI or RPC UI session. Only `agent_settled`, after queued continuations have drained, produces the
completion sound. Blocking `ui_prompt_start` events during that request also signal human attention; idle menus do not.

Headless SDK subagents and print/JSON sessions never notify, even when they load the complete extension bundle.
Extension-injected background-result runs do not rearm completion sound after the human request has already finished.
Tool results and low-level `agent_end` are not sound triggers. Cancellation, reload, and shutdown clear pending
notification state.

The package-local PowerShell script plays `%WINDIR%/Media/tada.wav` directly and retains taskbar flashing. It does not
depend on an account-local WAV, a former Claude profile, or a beep fallback. Missing or unplayable Windows audio is
reported as a warning rather than silently changing the sound. `PI_NOTIFY_SILENT=1` or `notify-mute` in the selected Pi
account root suppresses sound and flashing. Restart Pi or use `/reload` after updating the installed package.

Regression lesson: notification migration must verify the actual sound asset and child-session silence in the installed
bundle, not only rename profile paths or test source-level child markers.

## Whole-agent sandbox

Gate 5 replaces the legacy host-Pi/remote-tool design. Pi, its native tools, extensions, subprocesses, subagents, Git
clients, and development services execute in one `sbx` environment.

MPX creates a standalone host-owned private clone under its user-local state and mounts it as `/workspace`. The original
checkout and linked-worktree Git administration are not mounted. Changes reach the original checkout only through
explicit export/apply-back with repository, base, drift, and conflict checks.

The sandbox receives only:

- the private clone;
- canonical MPX Pi extension source or its build output;
- generated shared skills and agents;
- launch-bound runtime context;
- selected-identity Pi, Git, SSH, GitHub, and GitLab state;
- dedicated session and temporary state;
- a narrow host-UX bridge endpoint and nonce.

The selected identity is intentionally available to trusted extensions. It is excluded from releases, logs, public
envelopes, and the opposite identity. The sandbox must reject the original checkout, broad home mounts,
opposite-identity roots, unrelated host paths, and host Docker sockets. Sandbox failure is terminal and never selects
host execution.

## Host UX from the sandbox

- HTTPS and remote-repository OSC-8 links continue through the host terminal without a bridge.
- Development services run beside Pi in the sandbox. Assigned ports are published to the same host ports so footer
  `localhost` links remain valid.
- File and folder links translate `/workspace` to the host-owned private-clone path, never the original checkout.
- Pi's external editor uses a sandbox `EDITOR`/`VISUAL` shim and a nonce-bound host operation with blocking edit
  semantics.
- Explorer/editor operations are restricted to translated private-workspace or bounded temporary files. The bridge is
  not a general host command runner.

## Simplification and deletion

After host and sandbox parity pass, delete:

- the generated Pi footer and provider-neutral footer collectors;
- duplicate Git, quota, subagent, development-service, guard, editor, and widget implementations;
- generated Pi executable source and production bundles that exist only to recreate native extensions;
- the host-Pi remote-tool replacement, worker bridge, tool inventory, and proxy-only proof contracts;
- the duplicate vendored subagent tree;
- live source dependencies on the deprecated `mpx-pi` and `mpx-claude-code` repositories.

Retain only controls that enforce the useful boundary: selected identity, bounded mounts, no opposite identity, no
original checkout, no Docker socket, no silent host fallback, private-workspace lifecycle, session persistence, port
ownership, cleanup, and explicit apply-back.

## Acceptance

Host and sandbox acceptance must demonstrate:

- the same canonical Pi extension package and complete footer in both environments;
- normal discovery and `/reload` without duplicate tools or UI ownership;
- selected provider quota, Git, `gh`, `glab`, subagent, and development-service behavior;
- selected identity access and denial of opposite-identity canaries;
- open-network operation;
- exact effective mounts without the original checkout or Docker socket;
- writes confined to the private clone until explicit apply-back;
- working browser, file, folder, external-editor, and published-port flows;
- session persistence, resume, cleanup, and no host fallback;
- no remaining Pi-specific implementation dependency on the deprecated repository;
- no generated duplicate implementation of native Pi extension behavior.

Use `pnpm` for every package command. Run focused tests first, then repository checks, and run `pnpm run typecheck`
before each conventional commit.
