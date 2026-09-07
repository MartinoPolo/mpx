# ADR 0001: Private monorepo and shared contracts

- Status: Accepted

MPX uses one private TypeScript monorepo. Domain behavior belongs in workspace packages; the CLI and runtime integrations are thin adapters over public package APIs.

Canonical shared content lives under `content`. Runtime-specific implementation remains checked in under its runtime package. Generated artifacts and runtime projections are outputs, never canonical source.

Automation-capable commands emit versioned JSON envelopes. This structure prevents runtime drift, absolute cross-repository imports, and workflow logic in adapters.
