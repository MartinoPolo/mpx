# Production installation

`mpx install plan` is the dry-run surface. It reads an exact intent file, observes every target, and returns a deterministic confirmation digest without publishing a release or changing machine state. Apply requires that exact plan and digest.

Production builds use the workspace-pinned `esbuild` version to bundle the CLI and all workspace/runtime dependencies into `bin/mpx.mjs`. Releases copy that bundle; they do not import a source checkout. `%MPX_APPS%\mpx\bin\mpx.cmd` is the owned stable selector used by Windows Terminal and shortcuts. It reads `%LOCALAPPDATA%\mpx\active-release` and dispatches through the registered absolute Node executable to the selected immutable release bundle.

The session-capture scheduled task invokes the verified absolute Node executable directly. Its first argument is the immutable release's `bin\mpx.mjs`; the task ownership data records both the Node SHA-256 and the release-manifest CLI SHA-256. No `runner.exe` or `mpx.exe` is expected.

Managed shell aliases bind identities explicitly: `cc`/`pi` use `personal`, and `ccw`/`piw` use `work`. `ccd`/`ccwd` additionally require an interactive TTY and `MPX_DIRECT_REASON` before selecting the host executor.

Use `mpx install verify` for receipt, resource, selector, and immutable-file health; add `--strict` to report foreign release entries. Uninstall requires its exact plan confirmation and refuses foreign or drifted owned targets. It removes managed profiles, Terminal registration, user environment values, shortcuts, the scheduled task, stable command selector, and active-release selector while preserving unrelated native data.

Production changes are performed only by `apply` or confirmed `uninstall`. Tests and simulations use temporary filesystems and OS-bound fakes; they must not apply to the live user profile, registry, Terminal settings, shortcuts, or Task Scheduler.
