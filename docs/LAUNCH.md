# MPX v2 launch

`mpx launch claude|pi` resolves and executes the MPX v2 launch contract. Resolution produces a deeply immutable descriptor, a runtime-neutral resolved-skill manifest, and a runtime-specific immutable projection. Their hashes bind runtime, identity, project/repository/content scope, mode, skill policy, executor evidence, workspace, network policy, routes, approvals, and artifact bytes. A running process cannot widen that tuple: changed rights, bindings, executor evidence, or artifacts require a new launch and runtime restart (`LAUNCH_RESTART_REQUIRED`). `mpx launch current --json` reports only the validated process-bound hashes and binding.

## Selection and aliases

Identity is always explicit, including when supplied by a short alias. CWD classification never chooses identity or grants access. Aliases contribute only runtime and identity:

| Alias | Runtime | Identity |
| --- | --- | --- |
| `cc` | Claude | `personal` |
| `ccw` | Claude | `work` |
| `pi` | Pi | `personal` |
| `piw` | Pi | `work` |

Mode, skill policy, content scope, executor, workspace, and network policy still resolve through direct input, project default, longest matching content-scope default, then safe built-ins. Alias expansion does not add a preset, mode, policy, or grant.

## Execution gates

Docker is the safe default. The current production Docker adapter is deliberately **unverified pending F2** and launch fails with `EXECUTOR_GATE_UNVERIFIED`; there is no host fallback. This is not a claim of F2 container isolation.

Host is an elevated compatibility path, not isolation. It requires explicit `--executor host`, direct workspace where required, a nonempty reason, the descriptor's trusted elevation approval, and a fresh confirmation from a direct TTY. JSON/noninteractive execution cannot approve host mode. Approval is exact, one-use, and launch-bound.

Before spawning, MPX builds and revalidates the exact Claude or Pi projection and checks current executor evidence. Failed preconditions perform no projection or process side effect. Native account roots and materialized provider/Git/SSH/MCP routes remain private execution inputs: public descriptors, output envelopes, banners, and audit projections retain only safe labels, bindings, and digests.

Claude revalidates the full projection at its earliest supported hook checkpoints (`SessionStart`, `UserPromptSubmit`, and `PreToolUse Skill|Agent|Task|Bash`). These non-atomic compatibility checkpoints are not an atomic skill-load interceptor; self-modification between checkpoints cannot be claimed prevented.

## Runtime context, audit, and banner

The child receives an immutable `MPX_RUNTIME_CONTEXT` containing descriptor, manifest, artifact, and binding hashes. Claude additionally receives only its selected `CLAUDE_CONFIG_DIR`; Pi receives only its selected `PI_CODING_AGENT_DIR`. Other identities' private roots are not propagated.

Elevated descriptors carry a sanitized reason and `ELEVATED` banner state. The compact banner identifies runtime, executor, and a short launch key without private roots. Execution audit records are bounded safe projections of outcome and error code. These records do not authorize a later launch. Any policy or artifact change requires relaunch and process restart; in-process rights expansion is rejected.

Phase I provisions native private route data. Phase F only validates and consumes already-provisioned route directories; it never copies credentials. This surface does not claim F2 isolation, Phase G session resurrection, Phase I installation, or Phase J legacy retirement.
