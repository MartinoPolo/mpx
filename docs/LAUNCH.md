# MPX v2 launch

`mpx launch claude|pi` resolves and executes the MPX v2 launch contract. Resolution produces a deeply immutable descriptor, a runtime-neutral resolved-skill manifest, and a runtime-specific immutable published projection. The logical skill artifact and the launch-bound full published-projection reference are separate bindings. Their hashes bind runtime, identity, project/repository/content scope, mode, skill policy, executor evidence, workspace, network policy, routes, approvals, and artifact bytes. A running process cannot widen that tuple: changed rights, bindings, evidence, or artifacts require a new launch and runtime restart (`LAUNCH_RESTART_REQUIRED`). `mpx launch current --json` reports only validated process-bound hashes and binding.

## Selection and aliases

Identity is always explicit, including when supplied by a short alias. CWD classification never chooses identity or grants access. Aliases contribute only runtime and identity:

| Alias     | Runtime | Identity   |
| --------- | ------- | ---------- |
| `cc-mpx`  | Claude  | `personal` |
| `ccw-mpx` | Claude  | `work`     |
| `pi-mpx`  | Pi      | `personal` |
| `piw-mpx` | Pi      | `work`     |

The installer never redefines the user's native `cc`, `ccd`, `ccw`, `ccwd`, `pi`, or `piw` commands. The four standard `-mpx` launchers temporarily select explicit host execution, direct workspace, a compatibility reason, and one-use `--approve-host` authority. This is an acknowledged non-sandboxed continuity route while production sandbox routes remain unaccepted; the MPX launch pipeline, identity binding, runtime projection, account preflight, and audit still apply. Manual host launches without `--approve-host` retain direct-TTY confirmation.

Mode, skill policy, content scope, executor, workspace, and network policy still resolve through direct input, project default, longest matching content-scope default, then safe built-ins. Alias expansion does not add a preset, mode, policy, or grant. Project skills are resolved under the same policy and immutable artifact bindings as canonical skills; project location alone grants nothing.

Launch-only runtime arguments use repeatable `--runtime-arg <value>`. MPX bounds and canonicalizes them, includes them in the launch descriptor and `launchKey`, and appends them after runtime-owned arguments. They cannot come from durable configuration or ambient environment. Control characters, oversized collections, and use outside launch execution fail closed.

## Execution gates

Docker is the safe default. Production selects the pinned standalone-sbx backend when its live read-only diagnostics, canonical `SbxLaunchPlanExportV1`, packaged runtime-tool/executor inventories, and `F2ProofReportV2` all match exactly. Missing or stale proof remains a typed `EXECUTOR_GATE_UNVERIFIED` denial with no host fallback. The backend applies loopback ports and the selected named policy, starts a launch-private attested worker bridge, attaches the runtime, and awaits teardown. The selected standalone baseline is `open`, mapped to sbx global `allow-all`: it provides no destination-egress isolation. Filesystem, mount, process, identity, and proof bindings remain enforced and useful, but public egress can disclose anything readable inside the sandbox.

Host is an elevated compatibility path, not isolation. It requires explicit `--executor host`, direct workspace where required, a nonempty reason, and exact one-use launch-bound approval. Approval is either fresh direct-TTY confirmation or the explicit argv-scoped `--approve-host` flag; the latter is accepted only for an explicit host launch with a reason and is never read from durable configuration or the environment. Interactive runtime processes have no artificial 120-second lifetime; finite readiness and diagnostic probes remain bounded.

Before spawning, MPX builds and revalidates the exact runtime projection and performs an exact recheck of the selected executor evidence. Failed preconditions perform no projection or process side effect. Shared dangerous-command policy is applied consistently at runtime command boundaries.

Phase F consumes preprovisioned read-only private routes and MCP descriptors. It does not create, install, copy, or migrate them; Phase I owns provisioning. KanbanFlow authorization comes from the OS keyring, not a route configuration path. Private provider/Git/SSH/MCP inputs remain private: public descriptors, envelopes, banners, and audit projections retain only safe labels, bindings, and digests.

Claude integrity checkpoints are `SessionStart`, `UserPromptSubmit`, and `PreToolUse Skill|Agent|Task|Bash`. They are supported-boundary guards around an immutable copy, not an atomic native skill-load interceptor. Pi separately uses exact open-handle and body-hash checks.

## Runtime context, audit, and banner

The child receives immutable launch bindings including the logical artifact and full published-projection reference. Claude additionally receives only its selected `CLAUDE_CONFIG_DIR`; Pi receives only its selected `PI_CODING_AGENT_DIR`. Other identities' private roots are not propagated.

Elevated descriptors carry a sanitized reason and `ELEVATED` banner state. The compact banner identifies runtime, executor, and a short launch key without private roots. Audit output paths are hardened and records are bounded safe projections of outcome and error code. Records do not authorize a later launch. Any policy or artifact change requires relaunch and process restart; in-process rights expansion is rejected.

This surface does not claim F2 isolation, Phase I provisioning or installation, or Phase J legacy retirement. Session continuation/resume is delivered by the separate Phase G lifecycle and sessions components, not by the immutable runtime projection itself.
