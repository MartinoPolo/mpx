# MPX decisions

This document is the durable implementation source of truth. Linked technical documents define operational detail.

## Repository and architecture

- MPX is one private TypeScript monorepo. Former `mpx-pi` and `mpx-claude-code` repositories are migration provenance only, never runtime, build, or test authorities. Keeping domain behavior in workspace packages and the CLI and runtime integrations as thin adapters over public package APIs prevents cross-repository coupling and workflow drift.
- Runtime-neutral skills, agents, instructions, and profiles are canonical under `content`. `content/skills` owns workflow payloads; `packages/skills` owns catalog, manifest, artifact, compilation, and projection contracts.
- The content compiler is the sole final-byte renderer for managed skills and agents. Runtime adapters publish verified output unchanged; generated artifacts and runtime projections are outputs, never canonical source. This preserves one reviewable source for shared behavior.
- Canonical content describes semantic capabilities and model classes. Runtime profiles resolve native differences without claiming unsupported parity.
- Automation-capable commands emit strict, versioned JSON envelopes. Readers reject unknown schemas, unsafe paths, stale artifacts, ambiguous identities, and untrusted inputs rather than introducing fallback authorities.

## Native runtime ownership

- Native runtimes own authentication, credentials, account roots, sessions, trust, and runtime behavior. MPX does not ingest credentials or transcript content.
- Pi-specific behavior is canonical checked-in source under `runtimes/pi/extensions` and is loaded exactly once through native package discovery. MPX does not generate an alternative footer, tool, hook, command, editor, widget, lifecycle, configuration, keybinding, or theme implementation. This keeps native discovery and `/reload` available without duplicate activation.
- Generation is limited to runtime-neutral shared content and launch-bound data. Build output may package canonical Pi extension source but is never a second implementation.
- The Pi adapter selects the native account root, publishes compiled shared content, supplies validated launch context, and binds manifest integrity. Claude receives an immutable plugin projection. Claude and Pi share contracts and content, not runtime-specific hooks, lifecycle, UI, or session implementations.
- Canonical skills use `/mpx:<name>`; managed project skills use `/skill:<name>`. Pi Tab completion is required to operate through the real native editor path: it completes a mid-prompt partial command and applies a single match directly. Provider-only completion tests cannot substitute for this boundary, and automatic native-editor popups are not promised.

## Identity, configuration, and selection

- Identity selection is explicit and immutable. It is never inferred from working directory, project, domain, or provider. Native account ownership and provider routing are independent; stale or ambiguous identity, account-root, artifact, and launch bindings fail closed.
- `mpxconfig.json` schema 1 is the only committed project integration manifest and may select `skills.packs`. User configuration schema 2 owns identity pack allowances, project and location selection, and resource roots. Identities, machine roots, receipts, leases, credentials, and other mutable state remain user-local.
- Canonical skill packs are `development` and `personal`. Effective selection resolves from committed project, user project, then the most-specific canonical location, and must remain within the explicit identity allowance. Named skill policies, content scopes, `off`, and contextual exposure overrides are not runtime authorities.
- Managed exposure is `full`, `name-only`, or `explicit-only`; omitted valid metadata defaults to `full`, and bodies always load lazily. Explicit `metadata.mpx` opts project skills into managed ownership, while unmarked project skills remain runtime-native. Malformed or ambiguous ownership fails closed.
- Cross-pack workflows use qualified public `/mpx:<name>` commands, not relative `SKILL.md` dependencies. An unavailable required helper asks for its pack instead of loading excluded content, skipping work, or broadening selection. `project-register` and `init-github-repo` are independent: registration accepts folders with or without Git and never initializes or publishes a repository.
- Managed public native aliases remain suffixed. Configured user bare forwarders may coexist, but MPX does not claim bare commands globally.

## Current-only contracts and migration

- Runtime contracts are breaking and current-only. Normal operation has no legacy readers, former-repository dependencies, old command namespaces, permanent compatibility aliases, or fallback authorities. Current source names describe their role without version suffixes or roadmap labels; persisted and wire formats retain explicit numeric schema versions so incompatible data can be rejected safely.
- Personal and work roots are identity-owned. Native account and provider roots remain routing boundaries; explicit personal resource roots do not become durable storage domains.

## Installation and execution safety

- `mpx setup` is idempotent and may mutate only receipt-owned MPX resources. Existing evidence is validated before mutation; missing, corrupt, stale, foreign, partial, ambiguous, or concurrently changed ownership fails closed. Native launcher names, credentials, sessions, account roots, settings, and unrelated files remain untouched.
- Installed releases are immutable and self-contained: setup builds and bundles before publication, and strict verification checks the complete content-addressed release manifest without requiring development dependencies.
- Windows host execution is the supported release path. It requires explicit selection, a reason, and fresh approval, and is not isolation. Linux, macOS, Docker, and whole-agent sandbox execution are unavailable and never silently fall back to host.
- Executor readiness preserves account/root, executable/invocation, artifact, launch-binding, approval, and pre-spawn checks. Removed grant plumbing never mediated host reads.
- Launcher, configuration, or projection changes require startup smoke coverage for personal and work selections; help or doctor checks alone are insufficient.

## Providers, sessions, worktrees, and ports

- Issue, Review, and CI workflows independently resolve configured provider roles and use shipped native-provider references, not MPX provider-facade commands or credential-bearing command templates.
- The local Markdown Issue store is an application-owned, schema-versioned, private-root-mapped provider. Legacy issue formats are migration inputs only.
- The MPX session registry contains bounded lifecycle and resume metadata only; native runtimes own session files. Resume rebuilds and revalidates the launch before spawning. Incompatible session snapshot or record schema 2 authority requires relaunch rather than reinterpretation.
- Managed worktree creation, preparation, and removal are repository-locked and conservative. Pi handoff may fork Pi-owned session entries but never moves uncommitted changes or deletes worktrees automatically.
- Preparation executes revalidated allowlisted argument vectors without shell-string evaluation. The per-user port registry is authoritative; `.worktree-ports.json` is only a verified projection.

## Verification boundaries

- Tests protect distinct observable behavior or a concrete risk, not changing counts or coverage quotas. Prefer one authoritative test at the lowest useful boundary, adding adapter or integration coverage only for real boundary differences. Do not add runtime tests solely for TypeScript aliases, constants, schema layout, fake interfaces, or duplicate same-path matrices.
- TDD is optional and does not mandate extra suites. When contracts change, superseded compatibility expectations are deleted rather than preserved.
- Package unit tests and fixtures live with their workspace. Root contract, integration, and end-to-end suites cover distinct cross-boundary behavior without centralizing ownership or emitting tests in production builds. Payload-local tests remain with a skill only when they ship with or validate that payload.
- Cross-workspace behavior uses public package APIs. Production builds exclude tests. Verification and loading fail closed instead of using legacy fallbacks.
