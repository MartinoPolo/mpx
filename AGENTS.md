# Repository guidance

## Commands

Use pnpm. Run `pnpm run typecheck` before a commit and keep repository hooks enabled. The normal full
gate is:

```bash
pnpm run typecheck
pnpm build
pnpm test
```

When asked to update Pi extensions, run `pnpm run update:pi-extensions` from this repository. It
updates personal then work via native Pi, preserving pins, patches, and separate account configs.
Verify installed versions in both accounts and report any remaining drift.

## Source map

- `content/` is the authored skill, specialist, rule, and shared-instruction source.
- `dist/` is ignored, reproducible build output. Edit canonical content under `content/`, then run
  `pnpm build` from the repository root before launching a harness or running content checks.
  Never hand-edit or force-add generated projections.
- `src/` contains the compiler, configuration, launch, resume, safeguard, and runtime implementation.
- `extensions/` contains thin native Pi adapters.
- `bin/` contains Git Bash entrypoints.
- `migration/` contains current acceptance and recovery tooling, not normal runtime APIs.
- `patches/` contains reviewed checkout-local dependency and undeployed compatibility candidates.

User configuration is `$APPDATA/mpx/config.json`; repository configuration is `mpxconfig.json`.
Resolve machine locations from the documented `MPX_*` variables rather than hardcoding user paths.
Native account roots contain credentials, settings, and transcripts: do not inspect, copy, or replace
them broadly.

## Ownership boundaries

Pi and Claude Code own native authentication and session data. Orca owns worktrees, terminals, server
visibility, status, and desktop notifications. Do not add an MPX daemon, session registry, port
registry, or second attention writer.

Preserve unrelated native and project-authored resources. Project skills can override global skills;
never delete or rename one solely because its name collides. Establish provenance and compare behavior
first. Never write through legacy directory links.

## Content authoring

Before restructuring instructions, review their direct, transitive, and runtime consumers and agree
the disposition with the user. Keep essential agent behavior self-contained. Keep instructions concise and
complete, using at most one short example when useful.
