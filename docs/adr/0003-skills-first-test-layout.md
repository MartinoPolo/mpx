# ADR 0003: Skills-first architecture and test layout

- Status: Accepted

## Context

MPX needs a durable repository shape that makes canonical skills, platform contracts, runtime projections, and
application orchestration independently understandable. Its tests also need consistent taxonomy and commands without
erasing the ownership boundaries that make failures diagnosable.

## Decision

MPX is a skills-first local control plane. `content/skills` is the canonical payload. `packages/skills` is the platform
for catalog, manifest, artifact, and projection contracts. Runtimes translate verified runtime-neutral plans, and the
CLI composes public application operations.

Package-owned unit tests live outside production source at `<workspace>/test/unit`, with fixtures at
`<workspace>/test/fixtures`. Root `tests/contract`, `tests/integration`, and `tests/e2e` contain only cross-boundary
suites. A payload test remains inside a skill only when it ships with or validates that payload.

MPX unifies test taxonomy, configuration, and scripts, not test ownership. It does not put every test at the repository
root.

## Rejected alternatives

- **Tests mixed into `src`:** this obscures production boundaries and risks emitting tests in package builds.
- **All tests centralized at root:** this disconnects unit tests and fixtures from their owning workspace and makes
  dependency boundaries less explicit.
- **A big-bang package rewrite:** this combines structural, behavioral, and provenance risk and removes useful rollback
  boundaries.

## Consequences

Migration is incremental and includes coordinated path, import, configuration, and provenance work. Cross-workspace
behavior uses public workspace APIs. Production TypeScript configurations exclude tests. Runtime and CLI adapters stay
thin, and all verification and loading paths fail closed rather than using legacy fallbacks.

[ADR 0004](0004-canonical-native-pi-extensions.md) supersedes the tracked generated Pi-extension exception. Its
migration target makes Pi-specific implementation canonical checked-in source and limits generation/projection to
runtime-neutral shared content and launch-bound data.
