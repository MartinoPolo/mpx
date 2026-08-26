# Phase F2 standalone sbx runner

MPX accepts only the standalone Windows `sbx.exe` v0.39.0 build `def8cb0523a77e757bdd6ef52b459fe374f3783e`, SHA-256 `b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf`. The legacy Docker CLI sandbox plugin is never discovered or invoked.

## Read-only discovery

`mpx doctor` and Docker launch use an absolute `MPX_SBX_EXECUTABLE`, or absolute PATH entries, and verify the binary hash and real path outside the project. They invoke only `version`, `--help`, `daemon status --json`, and `diagnose --output json`, with `shell:false`, bounded output and a minimal OS-path child environment (no tokens or credentials). Unknown JSON/help fields and version/build drift fail closed. Discovery never runs daemon start/restart/reset, login, create, or attach.

Plans use v0.39 argv only: `create --name`, `run --name`, `exec`, `ports`, `policy ls`, `ls --json`, and `rm --force`. One proof-bound `StandaloneSbxLifecycleAdapter` executes the reviewed create/port/policy lifecycle and awaits `rm --force` on every terminal path; `StandaloneSbxExecutorAdapter` is its executor-facing API rather than a duplicate implementation. For Pi it starts the launch-private worker before attach and exposes only its bridge endpoint/attestation to runtime planning. For built-in Claude it delivers the immutable projection and launches the VM agent. The production CLI factory in `apps/cli/src/sbx-execution.ts` needs no caller injection. Exact proof `reportKey` evidence is reported only when pinned diagnostics pass and a sanitized live `F2ProofReportV1` exactly matches the generated plan, packaged inventory, pin, and executor evidence; otherwise Docker remains gated. Clone mode is main-checkout-only; host-worktree mode is linked-worktree-only. The workspace itself and extra mounts are checked against host runtime roots, credentials, the opposite identity domain, Docker sockets, and the Git common directory. A reviewed direct-main checkout may contain its own `.git`, but that does not permit a Git common directory above or outside the workspace. Environment is generated identity-local state only; host `CLAUDE_CONFIG_DIR`, native account paths, credentials, and the host Docker gateway are never forwarded.

## Production built-in Claude route

Claude launches use the built-in `claude` agent from the pinned standalone sbx release, never a host Claude executable. Every lifecycle command is scoped to `--app-name mpx-claude-personal` or `--app-name mpx-claude-work`; the proof gate requires a matching enrollment digest, Docker credential-isolation attestation, and denial of the opposite identity. MPX sends a digest-verified projection archive over stdin to `mpx-projection-receiver` and installs it at `/opt/mpx/projections/<sha256>`. It is not mounted from a native root or mutable host skill store.

The built-in Claude argv references only that VM projection's plugin and aggregate MCP configuration. The aggregate configuration targets the launch-bound Docker worker/policy surface, whose exact MCP, web/content, and development-service tool inventory is attested. `apps/cli`'s Claude gateway remains a host-executor adapter and is never projected, mounted, or named by this route. Host projection paths, native account roots, `CLAUDE_CONFIG_DIR`, API keys, and credential environment are rejected or omitted.

Named profiles are `deny-all`, `minimal`, `implementation`, `delivery`, and `research`; all default deny. Acceptance requires exact policy-check and policy-log decisions. Since v0.39.0 has no no-shared-skills flag, proof inspects the sandbox mount table and rejects `.claude`, `.pi`, or skills mounts.

## Fake proof

The production fake supports the complete pinned diagnostic and lifecycle surface (`version`, help, daemon diagnostics, create, attach, exec, policy, ports, list, and delete), including identity-scoped `--app-name` calls. The fake-sbx CLI launch test exercises built-in Claude, stdin projection delivery, content-addressed VM argv, Docker-worker MCP/dev calls, secret-free environment/argv, exact credential-proof mismatch, and awaited delete without a daemon, container, or authentication. The proof runner emits only `F2ProofReportV1` hashes. Raw stdout, stderr, paths, prompts, credentials, and fake secrets are not retained. Stored proof is invalid when the runtime-tool inventory digest changes.

## Live opt-in (not run by this change)

1. Review the current pin, runtime-tool inventory, executor evidence, plan, and named policy profile.
2. Start the daemon and authenticate manually if approved. MPX does not do either automatically.
3. Set `MPX_SBX_EXECUTABLE` to the trusted absolute pinned executable.
4. Compute raw SHA-256 digests for `docs/inventory/SBX_V0_39_0.json`, `docs/inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json`, and `packages/executors/src/index.ts`; obtain the reviewed plan key.
5. Run `scripts/run-f2-live-proof.ps1` with `-ConfirmLive`, `-ConfirmPhrase 'RUN MPX F2 LIVE PROOF'`, and all four exact digests.
6. Review mount, deny/allow policy, port-loopback, clone ownership, host-worktree, and cleanup evidence before accepting a live report.

Without every confirmation and current digest, the script exits before invoking `sbx`. It refuses a stopped daemon rather than starting it.
