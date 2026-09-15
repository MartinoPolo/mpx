# Repository guidance

## Commands

Use pnpm. Run `pnpm run typecheck` before a commit and keep repository hooks enabled. The normal full
gate is:

```bash
pnpm run typecheck
pnpm build
pnpm test
```

## Source map

- `content/` is the authored skill, specialist, rule, and shared-instruction source.
- `dist/` is deterministic committed output. Change source and rebuild; never hand-edit projections.
- `src/` contains the compiler, configuration, launch, resume, safeguard, and runtime implementation.
- `extensions/` contains thin native Pi adapters.
- `bin/` contains Git Bash entrypoints.
- `migration/` contains current acceptance and recovery tooling, not normal runtime APIs.
- `patches/` contains reviewed checkout-local dependency and undeployed compatibility candidates.

User configuration is `$APPDATA/mpx2/config.json`; repository configuration is `mpxconfig.json`.
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

## Documentation

Keep `README.md` focused on user-facing commands and setup. Keep `DECISIONS.md` limited to durable
choices and their rationale. Put changing acceptance state and recovery instructions under
`migration/`; keep current state in `migration/HANDOFF.md` and recovery in `migration/ACCOUNT_ROLLOUT.md`.
Retire one-off tooling and superseded reports to Git history. Package-local behavior may be documented
beside that package.
