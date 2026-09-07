# MPX

MPX is a skills-first local control plane for launching Claude and Pi with explicit identity, workspace, skill, network,
and executor boundaries. Canonical skill payloads drive verified runtime-neutral plans, while thin runtime and CLI
adapters expose them alongside worktrees, development services, sessions, accounts, and local issue workflows without
treating private runtime state as repository content.

## Start here

- **Install:** follow the setup-only [Installation](docs/INSTALLATION.md) flow.
- **Verify:** run `pnpm install --frozen-lockfile`, then `pnpm build`, `pnpm check`, `pnpm typecheck`, and `pnpm test`.
- **Launch:** configure MPX as described in [Configuration](docs/CONFIG.md), then see [Launch](docs/LAUNCH.md) for
  `mpx launch`, `cc-mpx`, `ccw-mpx`, `pi-mpx`, and `piw-mpx`.
- **Develop:** use `mpx workspace start|stop|logs` and the managed-port model documented in
  [Runtime adapters](docs/RUNTIME_ADAPTERS.md), [Ports](docs/PORTS.md), and [Worktrees](docs/WORKTREES.md).
- **Sessions:** see [Sessions installer](docs/SESSIONS_INSTALLER.md).
- **Issues:** see [Issues](docs/ISSUES.md) and [local Markdown issues](docs/local-markdown-issues.md).
- **Migration authority:** [MPX migration status, decisions, and acceptance](MPX_MIGRATION.md), governed structurally by
  [ADR 0003: Skills-first architecture and test layout](docs/adr/0003-skills-first-test-layout.md) and
  [ADR 0004: Canonical native Pi extensions](docs/adr/0004-canonical-native-pi-extensions.md).

## Private-state boundary

Tracked files contain source, schemas, shared-content projections, and public evidence only. User configuration, native
runtime roots, credentials, native authentication state, session registries and transcripts, leases, installer receipts,
sandbox state, and preparation logs belong under user-local application/state roots (normally `%APPDATA%/mpx` or
`%LOCALAPPDATA%/mpx`) and must not be committed, copied into releases, or exposed in diagnostics. A whole-agent sandbox
may deliberately receive its selected identity's runtime state for native Pi and trusted extensions; it must not receive
the opposite identity, original checkout, unrelated host state, or host Docker socket. Sandbox failure never falls back
silently to host execution.

## Platform support status

Windows is the current implementation and acceptance target. Linux and macOS support is deferred; installation, native
integration, launcher behavior, sandbox execution, and end-to-end runtime routes have not been verified or accepted on
either platform. See [deferred scope](MPX_MIGRATION.md#deferred-scope).
