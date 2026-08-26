# MPX

MPX is a local-first control plane for launching Claude and Pi with explicit identity, workspace, skill, network, and executor boundaries. It also manages worktrees, development services, sessions, accounts, and local issue workflows without treating private runtime state as repository content.

## Start here

- **Install:** follow [Installation](docs/INSTALLATION.md) and the immutable [installer design](docs/PHASE_I_INSTALLER.md).
- **Verify:** run `pnpm install --frozen-lockfile`, then `pnpm build`, `pnpm check`, `pnpm typecheck`, and `pnpm test`.
- **Launch:** configure MPX as described in [Configuration](docs/CONFIG.md), then see [Launch](docs/LAUNCH.md) for `mpx launch`, `cc`, `ccw`, `pi`, and `piw`.
- **Develop:** use `mpx dev` and the managed-port model documented in [Runtime adapters](docs/RUNTIME_ADAPTERS.md), [Ports](docs/PORTS.md), and [Worktrees](docs/WORKTREES.md).
- **Sessions and accounts:** see [Sessions installer](docs/SESSIONS_INSTALLER.md) and [Pi accounts](docs/PI_ACCOUNTS.md).
- **Issues:** see [Issues](docs/ISSUES.md) and [local Markdown issues](docs/local-markdown-issues.md).
- **Migration:** begin with [Migration](MPX_MIGRATION.md), [migration baseline](docs/MIGRATION_BASELINE.md), and [Phase J reconciliation](docs/PHASE_J_RECONCILIATION.md).

## Private-state boundary

Tracked files contain source, schemas, generated projections, and public evidence only. User configuration, native runtime roots, credentials, OAuth/account attestations, session registries and transcripts, leases, installer receipts, sandbox state, and preparation logs belong under user-local application/state roots (normally `%APPDATA%/mpx` or `%LOCALAPPDATA%/mpx`) and must not be committed, copied into generated content, or exposed in diagnostics. Docker execution does not widen access to host credentials or native runtime state; proof-bound admission fails closed rather than falling back to host execution.
