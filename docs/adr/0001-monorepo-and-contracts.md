# ADR 0001: Private monorepo and shared contracts

- Status: Accepted

MPX uses one private TypeScript monorepo. Domain behavior lives in workspace packages; the CLI, Claude Code plugin, and Pi extension are adapters over those packages. Automation output uses versioned JSON envelopes. Runtime artifacts are generated projections and are never canonical sources.

This prevents runtime drift, absolute cross-repository imports, and provider command logic in skills.
