# Linux and macOS portability

Linux and macOS are **not accepted MPX platforms yet**. The repository's portable Node ESM and TypeScript packages can be checked on either platform, but a successful repository check is not evidence that installation, native integration, launch, sandbox, runtime, or authentication routes work there. Do not announce live support or cut over an existing installation until the platform-specific gates below and the live gates in [MPX_MIGRATION.md](../MPX_MIGRATION.md) pass.

## Repository checks

Use Node.js 22.18 or newer and the workspace-pinned pnpm version. From a clean Bash checkout, run only the pnpm workflow:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm typecheck
pnpm test
```

These commands exercise repository-level TypeScript, generated-artifact, structure, formatting, lint, and automated test contracts. Record the OS/version, architecture, Node and pnpm versions, commit SHA, exact commands, exit codes, and sanitized logs. A pass does not close platform acceptance.

## Expected unsupported or Windows-specific surfaces

Treat the following as unsupported until a platform implementation and live evidence exist:

- The production installer and native registration described in [Installation](INSTALLATION.md) and [the Phase I installer design](PHASE_I_INSTALLER.md), including `%APPDATA%`/`%LOCALAPPDATA%`, `.cmd` selectors, registry/ACL integration, and PowerShell adapters.
- Windows Terminal profiles, scheduled tasks, and shortcuts.
- Windows-native process inspection, port-owner discovery, termination, and related capabilities.
- The pinned Windows standalone `sbx.exe` route, its daemon and VM lifecycle, and the proof-bound executor described in [Phase F2 standalone sbx](PHASE_F2_STANDALONE_SBX.md).
- End-to-end standalone sandbox/runtime/authentication routes, including built-in Claude enrollment and the host-Pi/OAuth split described in [Phase F2 proof foundation](PHASE_F2_PROOF_FOUNDATION.md).

The runtime-neutral launch contract in [Launch](LAUNCH.md) does not by itself establish that these native routes are available on Linux or macOS. Host execution remains elevated compatibility behavior, not sandbox isolation and not a portability substitute.

## Required manual evidence

Capture a separate, sanitized evidence set on a real Linux host and a real macOS host. For each platform:

- [ ] Complete the clean-checkout pnpm workflow above with version, commit, command, exit-code, and log evidence.
- [ ] Inventory every installer operation and classify it as implemented, intentionally omitted, or blocked; verify plan/apply/verify/uninstall and rollback on disposable user-local state without touching a real profile.
- [ ] Verify shell command discovery and aliases in a fresh Bash login shell, including project starting directory behavior and personal/work identity selection.
- [ ] Exercise config discovery, project/worktree paths, ports and development-service lifecycle, process inspection/termination, sessions, and status behavior with platform-native evidence.
- [ ] Exercise Claude and Pi projection/registration and launch for both personal and work identities; prove opposite-identity denial and that no native credential root is copied or exposed.
- [ ] Exercise each claimed executor/workspace/network-policy combination. For any sandbox claim, retain the required F2 plan/report plus mount, network, port, cleanup, daemon-restart, containment, and bypass observations.
- [ ] Verify runtime authentication routes and provider/Git/SSH/MCP routing without API-token substitution or secret-bearing diagnostics.
- [ ] Demonstrate uninstall/rollback and confirm unrelated files, profiles, credentials, and native runtime state remain unchanged.
- [ ] Review failures and unsupported capabilities explicitly; do not reinterpret skipped Windows-only checks as passes.

## Private-state and release safety

Use disposable user-local application/state roots for acceptance. Never commit or attach credentials, OAuth stores, account roots, private keys, session transcripts, prompts, raw private paths, installer receipts containing private data, or generated sandbox environment files. Evidence must contain bounded metadata, digests, redacted diagnostics, and safe labels only. See the repository [private-state boundary](../README.md#private-state-boundary) and the credential rules in [Launch](LAUNCH.md).

Documentation completion is not platform verification. Linux and macOS remain unverified until their separate manual evidence is reviewed and every applicable migration live gate passes; no support claim, default-route change, installation cutover, or legacy retirement should occur before then.
