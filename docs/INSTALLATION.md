# Production installation

Use the guided, read-only flow to construct and review an exact intent:

```bash
mpx install intent --request ./install-request.json > ./intent-result.json
mpx install plan --intent ./intent-result.json > ./install-plan.json
# Or build and plan in one read-only command:
mpx install prepare --request ./install-request.json
```

The request shape and exact external collection names (`external.gitRemotes[].request`, `external.obsidian[].request`, and `external.raycast[].derivative`) are documented in [PHASE_I_INSTALLER.md](PHASE_I_INSTALLER.md). Identity names and provider IDs are explicit for personal and work; executable path/version and complete Claude/Pi projection path/role inventories are mandatory. `userConfigPath` is a bounded source artifact and may be outside the absent target during bootstrap. Apply creates `%APPDATA%/mpx/config.json` only when absent and requires exact artifact bytes when it already exists. Uninstall retains this user-owned file.

`mpx install plan` remains the dry-run surface. It reads either a raw exact intent or the strict `install-intent-build-result` envelope, observes every installer target, and returns a deterministic confirmation digest without publishing a release or changing machine or external state. Apply requires that exact plan and digest.

Production builds use the workspace-pinned `esbuild` version to bundle the CLI and all workspace/runtime dependencies into `bin/mpx.mjs`. Releases copy that bundle; they do not import a source checkout. `%MPX_APPS%\mpx\bin\mpx.cmd` is the owned stable selector used by Windows Terminal and shortcuts. It reads `%LOCALAPPDATA%\mpx\active-release` and dispatches through the registered absolute Node executable to the selected immutable release bundle.

The session-capture scheduled task invokes the verified absolute Node executable directly. Its first argument is the immutable release's `bin\mpx.mjs`; the task ownership data records both the Node SHA-256 and the release-manifest CLI SHA-256. No `runner.exe` or `mpx.exe` is expected. After apply, manually run the managed scheduled task. Install verification requires a timestamped zero-result run after the ownership receipt's install time; an older successful run remains `not-run` and unhealthy.

Managed shell aliases bind identities explicitly: `cc`/`pi` use `personal`, and `ccw`/`piw` use `work`. `ccd`/`ccwd` additionally require an interactive TTY and `MPX_DIRECT_REASON` before selecting the host executor.

Use `mpx install verify` for receipt, resource, selector, and immutable-file health; add `--strict` to report foreign release entries. Receipt-bound external integrations fail closed as `verification-required` unless live evidence is supplied with `--external-plan <intent-result.json>`. Git remotes and Obsidian are verified read-only from the exact digest-bound plans. Raycast additionally requires `--raycast-post-export <evidence.json>`, a strict encrypted derivative map keyed by globally unique sorted integration IDs. Healthy exact bindings report `verified`; drift reports `unhealthy`. Verification never applies an external plan or mutates an external system.

Uninstall requires its exact plan confirmation and refuses foreign or drifted owned targets. It removes managed profiles, Terminal registration, user environment values, shortcuts, the scheduled task, stable command selector, and active-release selector while preserving unrelated native data.

Production changes are performed only by `apply` or confirmed `uninstall`. Tests and simulations use temporary filesystems and OS-bound fakes; they must not apply to the live user profile, registry, Terminal settings, shortcuts, or Task Scheduler.
