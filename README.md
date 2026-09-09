# MPX

MPX is a private-first local control plane for Claude Code and Pi. It compiles shared skills and agents, launches native runtimes with explicit identity and workspace boundaries, and coordinates sessions, worktrees, ports, and development services.

## Use

For repository development, install the checkout's exact dependency graph before running repository commands:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

To install that checkout as an immutable release, run `pnpm run setup`; the setup command already builds and bundles the release before publishing and verifying it. In a local checkout, `bin/mpx.mjs` and `bin/claude-gateway.js` are ignored generated outputs, rebuilt during setup before use; immutable installed releases are self-contained and do not depend on those checkout files.

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

Durable implementation policy and rationale are maintained in [`decisions.md`](decisions.md).
