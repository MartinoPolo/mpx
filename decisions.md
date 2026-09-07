# MPX decisions

This is the implementation source of truth; ADRs preserve rationale and linked technical documents define operational detail.

- MPX is one private TypeScript monorepo; `mpx-pi` and `mpx-claude-code` are migration provenance only, never runtime, build, or test authorities ([ADR 0001](docs/adr/0001-monorepo-and-contracts.md)).
- Domain behavior belongs in workspace packages; the CLI and runtime integrations remain thin adapters that use public workspace APIs.
- Runtime-neutral skills, agents, instructions, and profiles are canonical under `content`; `content/skills` owns payloads and `packages/skills` owns compilation and projection contracts ([ADR 0003](docs/adr/0003-skills-first-test-layout.md)).
- The content compiler is the sole final-byte renderer for managed skills and agents; adapters publish verified output unchanged, and generated projections are never canonical ([compiler architecture](docs/CONTENT_COMPILER_ARCHITECTURE.md)).
- Canonical content uses semantic capabilities and model classes; runtime profiles resolve native differences without claiming unsupported parity.
- Pi-specific behavior is canonical checked-in source under `runtimes/pi/extensions`, loaded exactly once through native package discovery; MPX never generates a duplicate Pi implementation ([ADR 0004](docs/adr/0004-canonical-native-pi-extensions.md)).
- Claude receives an immutable plugin projection; Claude and Pi share contracts and content, not runtime-specific hooks, lifecycle, or UI implementations ([runtime adapters](docs/RUNTIME_ADAPTERS.md)).
- Managed skills use `/mpx:<name>`; native project skills retain `/skill:<name>` unless explicit `metadata.mpx` opts them into managed compilation, and ambiguous ownership fails closed.
- Native runtimes own authentication, credentials, account roots, sessions, trust, and runtime behavior; MPX never ingests credentials or transcript content.
- Identity selection is explicit and never inferred from the working directory; stale or ambiguous identity, account-root, artifact, and launch bindings fail closed ([launch](docs/LAUNCH.md)).
- `mpxconfig.json` is the only committed project integration manifest; identities, machine roots, receipts, leases, credentials, and other mutable state remain user-local ([configuration](docs/CONFIG.md)).
- Automation-capable commands emit strict versioned JSON envelopes; readers reject unknown schemas, unsafe paths, stale artifacts, ambiguous identities, and untrusted inputs.
- Normal operation has no legacy readers, former-repository dependencies, old command namespaces, compatibility aliases, or fallback authorities ([ADR 0002](docs/adr/0002-no-permanent-legacy-readers.md)).
- One-time migration may inspect exact legacy state only with verified provenance and ownership, preserved user data, journaled mutation, and fail-closed ambiguity.
- `mpx setup` is idempotent and may mutate only receipt-owned resources; native launcher names and unrelated native settings remain untouched ([installation](docs/INSTALLATION.md)).
- Issue, Review, and CI workflows resolve independently configured provider roles and use shipped native-provider references, not MPX provider-facade commands or credential-bearing command templates ([providers](docs/PROVIDERS.md)).
- The local Markdown Issue store is an application-owned, schema-versioned, private-root-mapped provider; legacy issue formats are migration inputs only.
- The MPX session registry contains bounded lifecycle and resume metadata only; native runtimes own session files, and resume rebuilds and revalidates the launch before spawning ([sessions](docs/SESSIONS_INSTALLER.md)).
- Managed worktree creation, preparation, and removal are repository-locked and conservative; Pi handoff may fork Pi-owned session entries but never moves uncommitted changes or deletes worktrees automatically ([worktrees](docs/WORKTREES.md)).
- Preparation executes revalidated allowlisted argument vectors without shell-string evaluation; the per-user port registry is authoritative and `.worktree-ports.json` is only a verified projection ([ports](docs/PORTS.md)).
- Windows host execution is the supported release path, requires explicit selection, reason, and fresh approval, and is not isolation; Linux, macOS, Docker, and whole-agent sandbox execution are unavailable and never receive silent host fallback.
- Package unit tests and fixtures remain with their workspace; root contract, integration, and end-to-end suites cover cross-boundary behavior without centralizing ownership or emitting tests in production builds ([ADR 0003](docs/adr/0003-skills-first-test-layout.md)).
