# MPX2

Private, single-package migration checkout. **Not ready for daily use or cutover.**
[DECISIONS.md](DECISIONS.md) and [MIGRATION_PLAN.md](MIGRATION_PLAN.md) remain authoritative.

## Local development

```bash
pnpm install --ignore-scripts
pnpm build
pnpm run typecheck
pnpm test
pnpm status
```

`content/` is authored source; `dist/{packs,pi,claude}` contains deterministic committed
projections. Never edit projections. The initial slice contains the handoff skill and checker
specialist; the remaining inventory is not silently retired.

Public shell support is Git Bash. Checkout-local `bin/mpx`, `bin/pi`, `bin/piw`, `bin/cc`,
`bin/ccw`, and `bin/xpi` exist, but are **not installed into PATH**. Do not point daily launchers
here yet: safeguards, resume, extensions, account synchronization, and interactive acceptance
are unfinished. `sync`, `project setup`, and `resume` fail explicitly instead of pretending
installation or restoration succeeded; `lpi` likewise fails without launching a fallback.

## Configuration and launch preview

User-owned configuration will live at `$APPDATA/mpx2/config.json`; this checkout does not create
or alter that file. Required shape:

```json
{
  "accounts": {
    "personal": { "pi": "<absolute personal Pi root>", "claude": "<absolute personal Claude root>" },
    "work": { "pi": "<absolute work Pi root>", "claude": "<absolute work Claude root>" }
  },
  "domains": { "personal": ["${MPX_PROJECTS}"], "work": ["${MPX_WORK}"] },
  "executables": { "pi": "${MPX_PI_EXECUTABLE}", "claude": "${MPX_CLAUDE_EXECUTABLE}" }
}
```

Native roots must remain separate. Executable overrides can instead come directly from the two
approved environment variables. No credentials, MCP configuration, or account settings are copied.
`defaultPacks` optionally overrides personal/work defaults. Missing required roots are errors,
not guessed paths.

Repository `mpxconfig.json`:

```json
{
  "projectId": "example",
  "repository": { "provider": "gitlab", "remote": "origin" },
  "issues": { "provider": "kanbanflow", "metadata": { "boardId": "example" } },
  "packageManager": "pnpm",
  "packs": ["development"]
}
```

Repository/review and issue providers are independent. Supported repository providers: GitHub,
GitLab, Gerrit; issue providers: GitHub, KanbanFlow. Local issues are explicitly unsupported.
The package-manager field is metadata, **not** safeguard authority.

```bash
bash bin/mpx launch-preview pi work -- --literal-prompt
```

Preview prints only executable, arguments, selected account root and packs—not inherited secrets.
Explicit `packs: []` means native skills only. Invalid selections warn and fall back; unavailable
fallback paths warn and leave native resources enabled. The current slice has no personal pack,
so the default personal development+personal selection intentionally falls back to native-only.
Use an explicit repository selection only for disposable testing, not to pretend cutover is ready.

## Verification boundaries

Tests use temporary repositories, worktrees, account fixtures and separate native SDK processes.
They verify compiler bytes, actual native catalogs, trust boundaries, concurrent selections and
Windows/Git Bash argument forwarding. They do **not** establish live Claude/Pi interactive skill
invocation, native Tab completion, deployed subagents, Manual permissions, resume, reboot, Orca
status/notifications, or safeguard interception.

See [migration/INVENTORY.md](migration/INVENTORY.md),
[migration/PROGRESS.md](migration/PROGRESS.md), and [extensions/README.md](extensions/README.md).
