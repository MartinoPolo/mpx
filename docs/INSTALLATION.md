# Production installation

For normal human installation, configure `%APPDATA%/mpx/config.json` and the required `MPX_*` environment roots, then run:

```bash
mpx setup
```

`mpx setup` builds and validates the requested immutable release, then classifies existing installation evidence before resetting obsolete state or detaching legacy Pi links. With no installation evidence, the exact legacy-detachment path is unchanged. A verified current installation skips both reset and wholesale detachment, then plans, applies, and strictly verifies receipt-owned package and MPX resources. Deliberate native extension child links, agents, prompts, themes, and their targets remain untouched. Setup derives identity and provider selections from configuration route keys and never reads credentials.

Current-installation admission requires a parsed ownership receipt, strict immutable release verification, actual owned operation and locator verification, agreement with the active selector, and matching personal/work Pi identity, domain, and root registrations. Each requested root must contain exactly one receipt-owned canonical package source. Missing, corrupt, stale, foreign, or partial evidence fails closed; an old ownership schema is not blanket authority to skip detachment. Admission is digest-bound to the plan and revalidated inside the installer lock before mutation, rejecting intervening state changes.

Authorized pending installer transactions recover under the existing installer lock before strict classification. Recovery is separate from admission and planning; an unknown or unrecoverable journal blocks setup. If initial installation fails after legacy detachment, retry `mpx setup`; legacy external authority is intentionally not restored.

Installer planning, verification, automatic rollback after a failed apply, and restart recovery are internal components composed exclusively by `mpx setup`; there are no public installer rollback, uninstall, or external-action routes.

Production builds use the workspace-pinned `esbuild` version to bundle the CLI and all workspace/runtime dependencies into `bin/mpx.mjs`. Releases copy that bundle; they do not import a source checkout. `%MPX_APPS%\mpx\bin\mpx.cmd` is the owned stable selector used by managed shell launchers and shortcuts. It reads `%LOCALAPPDATA%\mpx\active-release` and dispatches through the registered absolute Node executable to the selected immutable release bundle.

Installation intentionally does not inspect, plan, write, adopt, verify, or remove Windows Terminal settings or profiles. Every existing Windows Terminal profile, including profiles named MPX or created by an older installer, is foreign to the production installer and remains untouched.

Background session capture activation is explicitly deferred and pending. The production base installer does not create, inspect, verify, adopt, or remove a Task Scheduler task, and a healthy base-install receipt does not claim that scheduled capture is active. Existing scheduled tasks, including `\\MPX\\Session Capture` from a legacy receipt, are outside current production ownership and remain untouched. Activation requires a future, separately confirmed feature.

Managed shell aliases use an explicit `-mpx` suffix and never redefine the native agent commands. `cc-mpx`/`pi-mpx` use `personal`, and `ccw-mpx`/`piw-mpx` use `work`; native `cc`, `ccd`, `ccw`, `ccwd`, `pi`, and `piw` remain owned by the user's existing installation. Until production sandbox routes pass end-to-end acceptance, the four standard `-mpx` launchers explicitly select host execution with direct workspace, a fixed compatibility reason, and the one-use `--approve-host` flag. This flag is explicit argv-scoped authority, not a durable or ambient approval, so these launchers do not prompt. Manual host launches without it retain the direct-TTY confirmations. `ccd-mpx`/`ccwd-mpx` require an interactive TTY and `MPX_DIRECT_REASON` before selecting the approved host executor.

The managed user environment derives `MPX_CLAUDE_EXECUTABLE` and `MPX_PI_EXECUTABLE` from the verified runtime-registration matrix. Both identities for a runtime must bind identical executable evidence; installation fails closed if they disagree.

Run the same bare `mpx setup` to idempotently verify and converge receipt, resource, selector, and immutable-file health. Receipt-safe upgrades validate exact prior ownership; drifted or foreign owned targets fail closed rather than being overwritten. A failed apply rolls back automatically from its durable journal and snapshots.

Projection payload ownership is matched by runtime identity and normalized logical path, preserving historical operation IDs across release changes. A payload absent from the new selection remains at its original target as an unchanged owned `ensure` operation with a `projection-retained` locator. The locator carries its original projection location and manifest-file evidence; later receipts carry that evidence unchanged without a receipt chain or dependency on historical release sources. Retained payloads are not active registrations and are never captured, applied, deleted, or restored by the transaction. Their bytes and modification times remain untouched. Missing, changed, or unsafe retained files fail verification rather than being reconstructed. A returning logical path reuses its owned ID in the newly selected release projection. Ordinary ownership verification checks retained files before and after activation; rollback restores only resources the transaction actually changed, preserving external changes to retained files.

Production changes are performed only by the setup-owned confirmed application flow. Tests and simulations use temporary filesystems and OS-bound fakes; they must not apply to the live user profile, registry, shortcuts, or Task Scheduler. Windows Terminal settings are outside the production installer boundary even for inspection.
