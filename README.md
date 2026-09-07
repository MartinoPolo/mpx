# MPX

MPX is a private-first local control plane for Claude Code and Pi. It compiles shared skills and agents, launches native runtimes with explicit identity and workspace boundaries, and coordinates sessions, worktrees, ports, and development services.

## Use

For repository development:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

For an already installed MPX CLI:

```bash
mpx setup
mpx doctor --cwd . --json
```

- [Configuration](docs/CONFIG.md)
- [Installation](docs/INSTALLATION.md)
- [Launch](docs/LAUNCH.md)
- [Content compiler](docs/CONTENT_COMPILER_ARCHITECTURE.md)
- [Runtime adapters](docs/RUNTIME_ADAPTERS.md)
- [Providers](docs/PROVIDERS.md)
- [Sessions](docs/SESSIONS_INSTALLER.md)
- [Ports](docs/PORTS.md) and [workspaces](docs/WORKTREES.md)

The generated CLI references under `content/instructions/shared/MPX_CLI_*.md` are authoritative for the current command inventory.

## Boundaries

- `mpxconfig.json` is the only committed project integration manifest.
- Credentials, native runtime roots, sessions, receipts, leases, and other mutable machine state remain user-local.
- Native Pi and Claude own authentication, session formats, and runtime behavior. MPX supplies validated launch data and compiled content.
- Windows is the accepted host platform. Linux, macOS, and whole-agent sandbox execution are not currently supported release paths.

Current implementation decisions are indexed in [`decisions.md`](decisions.md). ADRs under [`docs/adr`](docs/adr) preserve rationale and history.
