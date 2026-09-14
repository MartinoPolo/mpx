# MPX2

Private, single-package migration checkout. **Not ready for installed cutover or daily-use acceptance.**
[DECISIONS.md](DECISIONS.md) is authority; [MIGRATION_PLAN.md](MIGRATION_PLAN.md) owns acceptance.
Current implementation, evidence and remaining gates: [migration/PROGRESS.md](migration/PROGRESS.md).

## Local development

Node 22.20+ (verified on 22.23.1), pnpm 11.15.1, public Git Bash:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm run typecheck
pnpm test
pnpm status
```

`content/` is authored authority; `dist/{packs,pi,claude}` contains deterministic **committed**
projections. Never edit projections. Current coverage: 51 skills, 21 specialists, 16 rules,
shared/provider/harness instructions and terse style; 195 canonical files, 386 projections.
All current workflows/support contracts were retained or explicitly adapted, not silently retired.
See [migration/COVERAGE.md](migration/COVERAGE.md) for source provenance.

The runtime supplies thin native context/safeguard/format/UI adapters, native resume preparation,
owned registration previews and an Agent Resurrect/Orca launch recipe. It does not provide a daemon,
session registry, credential router, project server manager, or competing notification writer.
The only upstream patch is checkout-local pi-subagents 0.19.0 selected-pack discovery/preloading.
The installed 0.14.3 migration bootstrap remains untouched.

## Configuration

User configuration lives at `$APPDATA/mpx2/config.json`; these development commands do not create
or alter it. Example required shape:

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

Native roots stay separate. Executable overrides may instead use those two approved environment
variables. Missing required roots are errors, not guessed paths. Native authentication, settings,
packages and histories remain native; no credential/history copying occurs. `defaultPacks` optionally
overrides personal/work defaults. Optional `piTitle` specifies an exact `provider`, `model`, and
`thinking` level; without an available supported configuration, naming uses a prompt-derived fallback,
not another model. Existing/manual names are preserved.

Repository-owned `mpxconfig.json` keeps repository and issue routing independent:

```json
{
  "projectId": "example",
  "repository": { "provider": "gitlab", "remote": "origin" },
  "issues": { "provider": "kanbanflow", "metadata": { "boardId": "example" } },
  "packageManager": "pnpm",
  "packs": ["development"]
}
```

Repository providers: GitHub/GitLab/Gerrit. Issue providers: GitHub/KanbanFlow; local issues stop
explicitly. Package-manager metadata is **not** safeguard authority. Explicit `packs: []` selects
native skills only; invalid/unavailable selection is diagnosed without disabling native resources.

## Preview and inspection

Checkout-local `bin/mpx`, `pi`, `piw`, `cc`, `ccw`, `xpi`, and `lpi` are not installed into PATH.
**Do not apply account synchronization or point daily launchers here without cutover authorization.**

```bash
bash bin/mpx launch-preview pi work -- --literal-prompt
bash bin/mpx sync --preview
bash bin/mpx sync --agents-only --preview
bash bin/mpx sync --orca-hooks-only --preview
bash bin/mpx project setup --preview
bash bin/mpx resume --list
bash bin/mpx resume --preview '<absolute Pi transcript>' --account work
bash bin/mpx check-staged-secrets .
bash bin/mpx check-package-manager 'pnpm install' .
```

Full sync can install owned links/native registrations after authorization; previews/status report
missing resources and conflicts rather than treating agent links alone as readiness. Unrelated native
settings/packages/hooks are preserved. Removing `--preview` permits writes: this migration has used
only disposable-account installation fixtures. Project setup creates only the optional project-owned
skill link; Orca snippets are text, not terminal/server startup.

Resume supports native Pi/Claude account/project selection and exact launch preparation. Pi's no-session
RPC preflight verifies native model/auth/effort availability without a provider request or transcript
mutation. **Preflight is not resumed-startup acceptance.** Unknown saved Claude effort requires an
explicit override; no guessed restoration or Claude startup verification is claimed.

Legacy access requires `legacyPi.accountRoot` and `legacyPi.checkout`, separate existing resources and
complete retained native packages/tool-display entries. The known footer hardcoding a different
`~/.pi/agent` root still blocks launch. An approved copied footer patch passes a native account-root
probe, but is not installed/selected. Retired manager/alert entrypoints are excluded; no reduced fallback
or full legacy compatibility acceptance is implied.

## Verification boundaries

The current automated gate passes 225 tests, typecheck, frozen installation and projection drift checks.
Fixtures use disposable repositories/accounts, actual native loaders/sessions/tool loops and offline
model streams. Safeguards, formatting serialization, selected-pack children, resume preparation and
resurrection adapters are exercised without an installed cutover.

Native web/MCP/question packages load for both accounts. Local MCP/question callbacks pass; web's
loopback request is SSRF-blocked, **not successful retrieval**. Existing package versions are preserved.
The approved checkout-local Orca hook candidate passes actual native child/follow-up/result-consumption
fixtures without premature completion. The approved receiver candidate preserves cancellation through
normalization and renderer ingress; Orca's formatter says **stopped**, not **finished**. Both candidates
remain **undeployed**. Existing stopped notifications/unread attention are not suppressed by this patch.
See [migration/evidence-orca-receiver.md](migration/evidence-orca-receiver.md),
[migration/evidence-orca-compat.md](migration/evidence-orca-compat.md) and
[migration/evidence-legacy-compat.md](migration/evidence-legacy-compat.md).

These checks do not prove authenticated workflows, real compaction summaries, physical newline/wheel/
footer/title/question behavior, resumed startup, Orca attention/notification fidelity, or reboot
restoration. Those remain explicit human/live gates. No remote creation, push, source archival/rename,
credential migration, installed cutover, or reboot has occurred.
