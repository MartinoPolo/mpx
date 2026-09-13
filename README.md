# MPX2

Private, single-package migration checkout. **Not ready for daily use or cutover.**
[DECISIONS.md](DECISIONS.md) and [MIGRATION_PLAN.md](MIGRATION_PLAN.md) remain authoritative.

## Local development

Requires Node 22.20+ (tested on 22.23.1) and pinned pnpm 11.15.1.

```bash
pnpm install --ignore-scripts
pnpm build
pnpm run typecheck
pnpm test
pnpm status
```

`content/` is authored source; `dist/{packs,pi,claude}` contains deterministic committed
projections. Never edit projections. The retained slice contains the handoff skill, checker,
explorer, seven reviewer specialists, their shared protocol, five framework guides and shared
compaction guidance. The remaining inventory is not silently retired.

Public shell support is Git Bash. Checkout-local `bin/mpx`, `bin/pi`, `bin/piw`, `bin/cc`,
`bin/ccw`, and `bin/xpi` exist, but are **not installed into PATH**. Do not point daily launchers
here yet: safeguards, resume, extensions, account synchronization, and interactive acceptance
are unfinished. Full `sync`, `project setup`, actual resume launch and `lpi` fail explicitly
instead of pretending installation or restoration succeeded. Scoped operations are available below.

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
approved environment variables. No credentials, MCP configuration, or whole account settings are
copied; the separate scoped hook operation below mirrors only Orca-managed entries.
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

## Scoped development operations

```bash
bash bin/mpx sync --agents-only --preview
bash bin/mpx sync --orca-hooks-only --preview
bash bin/mpx resume --list
bash bin/mpx resume --preview '<absolute Pi transcript>' --account work
bash bin/mpx check-staged-secrets .
bash bin/mpx check-package-manager 'pnpm install' .
```

- Specialist sync touches only individual generated-agent links. Removing `--preview` permits
  those link writes; conflicting/unrelated entries are preserved and stale links reported, not deleted.
  `status` inspects links when user configuration exists. No live account sync has been performed.
- Orca-only sync mirrors three marked Pi files and managed nested Claude hooks, preserving unrelated
  settings and `statusLine`. Removing `--preview` permits those writes. Missing sources, unsafe paths
  and target-only hook metadata conflicts are reported without overwriting the affected resource.
  Only disposable accounts have been tested; this is not Orca/UI acceptance.
- Resume currently lists/inspects native Pi v3 files read-only. Unknown provider/model/effort needs
  an explicit, labeled override; preview is **not** proof of actual restoration or model availability.
- Staged-secret scanning is bounded, read-only and standalone. Credible findings block; uncertain
  findings and collection failures warn. Package-manager inspection likewise never executes its
  input; it uses native package/lock/workspace evidence, warns on unresolved shell scope, and blocks
  credible mismatches/direct `npx tsc`. Hook interception is not yet installed.
- The Pi context extension is fixture-tested but not registered in live accounts. It preserves native
  compaction mechanics, adds retained guidance, and supplies concise style and allowlisted roots.

## Verification boundaries

Tests use temporary repositories, worktrees, account fixtures and separate native SDK processes.
They verify compiler bytes, actual native catalogs, trust boundaries, concurrent selections and
Windows/Git Bash argument forwarding. A separate native Pi process verifies actual model-bound
context using a synthetic model stream. `migration/claude-probe.mjs` runs the installed Claude
against a disposable loopback backend with tools disabled: additive skill catalogs, leading handoff
expansion, exact-ID history and account isolation passed. Naive resume changed model/effort;
explicit selectors preserved history and corrected both. The probe intentionally exits 1 for that
native fidelity gap; missing saved effort remains unknown.

These fixtures do **not** establish live Claude/Pi interactive workflow completion, native Tab
completion, deployed subagent model invocation, Manual permissions, real compaction summaries,
complete resume, reboot, Orca status/notifications, or safeguard interception.

See [migration/INVENTORY.md](migration/INVENTORY.md),
[migration/PROGRESS.md](migration/PROGRESS.md), and [extensions/README.md](extensions/README.md).
