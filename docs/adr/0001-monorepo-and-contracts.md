# ADR 0001: Private monorepo and shared contracts

- Status: Accepted

MPX uses one private TypeScript monorepo. Domain behavior lives in workspace packages; the CLI, Claude Code plugin, and
Pi extension are adapters over those packages. Automation output uses versioned JSON envelopes. Build artifacts and
runtime-neutral projections are never canonical sources; runtime-specific adapter source remains checked in as clarified
by [ADR 0004](0004-canonical-native-pi-extensions.md).

This prevents runtime drift, absolute cross-repository imports, and provider command logic in skills.
