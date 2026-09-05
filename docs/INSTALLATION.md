# Production installation

For normal human installation, configure `%APPDATA%/mpx/config.json` and the required `MPX_*` environment roots, then run:

```bash
mpx setup
```

`mpx setup` builds and validates the current immutable release before changing native state, durably detaches recognized legacy Pi links, then plans, applies, and strictly verifies that exact release. It derives identity and provider selections from configuration route keys and never reads credentials. Re-running it reuses the immutable release, installer receipt, and legacy-detachment receipt. If installation fails after detachment, retry `mpx setup`; legacy external authority is intentionally not restored.

The standalone protocol below remains available for automation and review. It does not run legacy Pi detachment. Use the guided, read-only flow to construct and review an exact intent:

```bash
mpx install intent --request ./install-request.json > ./intent-result.json
mpx install plan --intent ./intent-result.json > ./install-plan.json
# Or build and plan in one read-only command:
mpx install prepare --request ./install-request.json
```

The request shape and retained external collection (`external.gitRemotes[].request`) are documented in [PHASE_I_INSTALLER.md](PHASE_I_INSTALLER.md). Identity names and provider IDs are explicit for personal and work; executable path/version and complete Claude/Pi projection path/role inventories are mandatory. `userConfigPath` is a bounded source artifact and may be outside the absent target during bootstrap. Apply creates `%APPDATA%/mpx/config.json` only when absent and requires exact artifact bytes when it already exists. Uninstall retains this user-owned file.

`mpx install plan` remains the dry-run surface. It reads either a raw exact intent or the strict `install-intent-build-result` envelope, observes every installer target, and returns a deterministic confirmation digest without publishing a release or changing machine or external state. Apply requires that exact plan and digest. When a healthy prior release is installed, this same flow emits a receipt-bound `ownership-release-upgrade` confirmation item and permits only exact prior-owned targets to transition. Drifted or foreign targets fail before mutation; failed upgrades restore the prior receipt and bytes while retaining immutable release content.

Production builds use the workspace-pinned `esbuild` version to bundle the CLI and all workspace/runtime dependencies into `bin/mpx.mjs`. Releases copy that bundle; they do not import a source checkout. `%MPX_APPS%\mpx\bin\mpx.cmd` is the owned stable selector used by managed shell launchers and shortcuts. It reads `%LOCALAPPDATA%\mpx\active-release` and dispatches through the registered absolute Node executable to the selected immutable release bundle.

Installation intentionally does not inspect, plan, write, adopt, verify, or remove Windows Terminal settings or profiles. Every existing Windows Terminal profile, including profiles named MPX or created by an older installer, is foreign to the production installer and remains untouched.

Background session capture activation is explicitly deferred and pending. The production base installer does not create, inspect, verify, adopt, or remove a Task Scheduler task, and a healthy base-install receipt does not claim that scheduled capture is active. Existing scheduled tasks, including `\\MPX\\Session Capture` from a legacy receipt, are outside current production ownership and remain untouched. Activation requires a future, separately confirmed feature.

Managed shell aliases use an explicit `-mpx` suffix and never redefine the native agent commands. `cc-mpx`/`pi-mpx` use `personal`, and `ccw-mpx`/`piw-mpx` use `work`; native `cc`, `ccd`, `ccw`, `ccwd`, `pi`, and `piw` remain owned by the user's existing installation. Until production sandbox routes pass end-to-end acceptance, the four standard `-mpx` launchers explicitly select host execution with direct workspace, a fixed compatibility reason, and the one-use `--approve-host` flag. This flag is explicit argv-scoped authority, not a durable or ambient approval, so these launchers do not prompt. Manual host launches without it retain the direct-TTY confirmations. `ccd-mpx`/`ccwd-mpx` require an interactive TTY and `MPX_DIRECT_REASON` before selecting the approved host executor.

The managed user environment derives `MPX_CLAUDE_EXECUTABLE` and `MPX_PI_EXECUTABLE` from the verified runtime-registration matrix. Both identities for a runtime must bind identical executable evidence; installation fails closed if they disagree.

Use `mpx install verify` for receipt, resource, selector, and immutable-file health; add `--strict` to report foreign release entries. Receipt-bound external integrations fail closed as `verification-required` unless live evidence is supplied with `--external-plan <intent-result.json>`. Git remotes are verified read-only from exact digest-bound plans. Healthy exact bindings report `verified`; drift reports `unhealthy`. Verification never applies an external plan or mutates an external system.

Uninstall requires its exact plan confirmation and refuses foreign or drifted owned targets. It removes managed `.bashrc` and PowerShell startup-profile launcher blocks, user environment values, shortcuts, stable command selector, and active-release selector while preserving unrelated native data. It does not inspect or remove Windows Terminal settings, profiles, or scheduled tasks.

Production changes are performed only by `apply` or confirmed `uninstall`. Tests and simulations use temporary filesystems and OS-bound fakes; they must not apply to the live user profile, registry, shortcuts, or Task Scheduler. Windows Terminal settings are outside the production installer boundary even for inspection.
