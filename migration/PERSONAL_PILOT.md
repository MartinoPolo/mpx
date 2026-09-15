# Personal Prejemesi pilot

The personal pilot is installed; live acceptance is still pending. The existing personal native
profile is shared, not isolated. No global Pi engine, installed MPX release, original legacy source,
work/Claude profile, Orca app/hook, production service, or remote was replaced by this apply.

## Routes in a fresh Git Bash shell

| Command | Route |
| --- | --- |
| `pi` | MPX2 personal, checkout-pinned native Pi |
| `xpi` / `xpiw` | Existing installed MPX personal/work |
| `lpi` / `lpiw` | Original legacy personal/work launchers |
| `piw` | Existing installed MPX work; not rolled out |

The user approved `lpi` as the Prejemesi fallback. Installed MPX rejects the converted
`mpxconfig.json`, so `xpi` cannot run in that checkout until the old manifest is restored. Its
launcher has no supported alternate-manifest input. Other compatible checkouts remain separate.

## What changed

- `.bashrc` routing, without prepending MPX2's bin directory to PATH.
- `%APPDATA%/mpx2/config.json` with account/domain paths and the checkout-pinned Pi executable.
- Prejemesi `mpxconfig.json`, converted in place; its existing dirty `.mpx/DECISIONS.md` was retained.
- Personal profile: owned runtime forwarding module and specialist links; private copies of linked
  UI settings and the agents directory, retaining the original junction for recovery.
- Personal native settings: explicit legacy display/skill auto-discovery filters and owned UI keys.
  Original legacy launchers explicitly restore their display and shared skills. Unrelated native
  packages/settings remain. Authentication and conversation files were not migration targets.

`sync --runtime-only --account personal --harness pi` selects only that account/harness's runtime
registration and owned UI settings. It does not switch shell aliases, convert project manifests,
install specialist links, upgrade native packages, or deploy Orca. `--preview` does not apply changes.
The pilot script performs the separately approved steps around that scoped operation.

## Manual acceptance

Keep a working legacy terminal available. Open a **fresh Windows Terminal Git Bash outside Orca**:

```bash
cd "$MPX_PROJECTS/prejemesi"
pi
```

1. Confirm `MPX2 · PERSONAL · Pi`, no extension-load errors, and expected skills/tool discovery.
2. Send a harmless prompt asking for a short reply without tools or file changes. Check multiline
   input with Shift+Enter or Ctrl+J. Physical startup and authenticated execution are not fixture proofs.
3. Ask `mpx-explorer` to identify the framework from `package.json` without changes. Check one child
   launch/result and model/effort reporting. Report errors rather than changing native packages.
4. If necessary, exit the pilot and run `lpi` from the same directory. Do not use `xpi` there while
   the converted manifest remains. This fallback shares the personal account but preserves the
   original extension sources and explicit legacy resource selection.

Do not test Orca attention yet. Paired hook/receiver deployment and the approved quiet-deliberate-
cancellation policy remain pending; success/error attention should remain normal.

## Footer acceptance after the approved redesign

The profile's existing forwarding module loads the checkout implementation. Once the current turn
is finished, `/reload` or a fresh `pi` session picks up the footer changes; no profile reinstallation,
package upgrade, or Orca hook deployment is required. The original `lpi` footer stays unchanged.

Check the session title (or `New session`), colored `Personal`, shortened model and diamond effort,
without a trailing effort word, and location links: white project folder name (not owner/project),
linked worktree only when outside the main checkout, then branch. The context row has no label:
current agent context tokens with percentage in parentheses, a bar, and cost. Context/quota usage
and effort diamonds use their legacy colors; compaction history with pre-compaction token counts
follows context, then quota/reset.
The context bar/colors measure the compaction trigger while the percentage measures the model
window. Limits use accent-colored filled cells and dark empty cells, with bare countdowns and
no `Quota` or `resets in` labels. All separators, including the finished-agent divider, are subdued gray. Resize the pane to check finished-agent placement
on the right versus below. Check native link clicks in Orca separately from notification behavior.
There should be no ports, branch-state counts, cumulative/subagent token totals, or shortcut-help column.

Quota restores the legacy Codex usage-endpoint GET using native selected-account provider auth,
in addition to ordinary response headers. Refreshes are single-flight, at most once per minute,
with bounded requests, retained observations on failure, and cancellation on disposal/provider switch.
No direct credential-file reader or inference request is added. Actual authenticated quota retrieval
still needs live acceptance; automated checks use fake transport/auth only. Existing completed-agent rows
are session-local; reload can clear that display history without deleting the native conversations.
The prior package-inspection warning and Orca attention incidents remain separate unresolved work.

## Recovery

Protected backup and write-ahead apply record:

`C:/_MP_apps/_backups/mpx2-personal-pilot-2026-09-14T14-03-39.437Z`

The backup is current-user/SYSTEM restricted. Files were individually stabilized and copied bytes
reread/hash-verified; it is not a globally atomic snapshot. Link targets were recorded, not traversed.
Do not restore the entire account over newer authentication or conversations.

Preview recovery first; add `--apply` only when deliberately rolling back:

```bash
backup="$MPX_APPS/_backups/mpx2-personal-pilot-2026-09-14T14-03-39.437Z"
node "$backup/rollback-personal-pilot.mjs" "$backup"
# After reviewing the preview:
node "$backup/rollback-personal-pilot.mjs" "$backup" --apply
```

The standalone recovery script requires Node but not the MPX2 checkout's dependencies. Recovery
restores routing/project configuration and pilot-owned UI/filter settings, removes unchanged owned
registrations, and preserves newer unrelated settings, credentials and conversations. Original UI
links return only when no unrelated private changes would be lost. The private pilot agents directory
is retained rather than deleted. Concurrent changes cause refusal, not forced overwrite; ask for
review if that occurs. Open a fresh shell after rollback.

## Evidence boundary

`verify-personal-pilot.mjs` confirmed applied file hashes, specialist link targets, original legacy
configuration/agent bytes and installed MPX launcher bytes against the protected record/backup.
Scoped runtime preview converges without changes; shell syntax and rollback preview pass. Actual
wrapper `--version` reports Pi 0.85.1; Prejemesi launch preview selects personal development/personal
packs. These are not live TUI, provider, resumed startup, full legacy workflow, or reboot acceptance.

See [PROGRESS.md](PROGRESS.md) for repository checks and remaining migration gates.
