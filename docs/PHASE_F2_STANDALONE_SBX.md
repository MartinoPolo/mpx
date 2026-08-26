# Phase F2 standalone sbx runner

MPX accepts only the standalone Windows `sbx.exe` v0.39.0 build `def8cb0523a77e757bdd6ef52b459fe374f3783e`, SHA-256 `b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf`. The legacy Docker CLI sandbox plugin is never discovered or invoked.

## Read-only discovery

`mpx doctor` and Docker launch use an absolute `MPX_SBX_EXECUTABLE`, or absolute PATH entries, and verify the binary hash and real path outside the project. They invoke only `version`, `--help`, `daemon status --json`, and `diagnose --output json`, with `shell:false`, bounded output and a minimal OS-path child environment (no tokens or credentials). Unknown JSON/help fields and version/build drift fail closed. Discovery never runs daemon start/restart/reset, login, create, or attach.

Plans use v0.39 argv only: `create --name`, `run --name`, `exec`, `ports`, `policy ls`, `ls --json`, and `rm --force`. `StandaloneSbxExecutorAdapter` now executes the reviewed create/port/policy/attach sequence and awaits `rm --force` on every terminal path. It reports verified evidence only when pinned diagnostics pass and a sanitized live `F2ProofReportV1` exactly matches the plan, inventory, pin, and executor evidence; otherwise Docker remains gated. Clone mode is main-checkout-only; host-worktree mode is linked-worktree-only. The workspace itself and extra mounts are checked against host runtime roots, credentials, the opposite identity domain, Docker sockets, and the Git common directory. A reviewed direct-main checkout may contain its own `.git`, but that does not permit a Git common directory above or outside the workspace. Environment is generated identity-local state only; host `CLAUDE_CONFIG_DIR`, native account paths, and the host Docker gateway are never forwarded.

Named profiles are `deny-all`, `minimal`, `implementation`, `delivery`, and `research`; all default deny. Acceptance requires exact policy-check and policy-log decisions. Since v0.39.0 has no no-shared-skills flag, proof inspects the sandbox mount table and rejects `.claude`, `.pi`, or skills mounts.

## Fake proof

The production fake supports the complete pinned diagnostic and lifecycle surface (`version`, help, daemon diagnostics, create, attach, exec, policy, ports, list, and delete). Executor tests exercise create/ports/policy/attach/awaited-delete and exact proof mismatch without a daemon or authentication. The proof runner emits only `F2ProofReportV1` hashes. Raw stdout, stderr, paths, prompts, credentials, and fake secrets are not retained. Stored proof is invalid when the runtime-tool inventory digest changes.

## Live opt-in (not run by this change)

1. Review the current pin, runtime-tool inventory, executor evidence, plan, and named policy profile.
2. Start the daemon and authenticate manually if approved. MPX does not do either automatically.
3. Set `MPX_SBX_EXECUTABLE` to the trusted absolute pinned executable.
4. Compute raw SHA-256 digests for `docs/inventory/SBX_V0_39_0.json`, `docs/inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json`, and `packages/executors/src/index.ts`; obtain the reviewed plan key.
5. Run `scripts/run-f2-live-proof.ps1` with `-ConfirmLive`, `-ConfirmPhrase 'RUN MPX F2 LIVE PROOF'`, and all four exact digests.
6. Review mount, deny/allow policy, port-loopback, clone ownership, host-worktree, and cleanup evidence before accepting a live report.

Without every confirmation and current digest, the script exits before invoking `sbx`. It refuses a stopped daemon rather than starting it.
