# Native adoption recovery

Current installation and remaining acceptance are tracked in [HANDOFF.md](HANDOFF.md).
Native account credentials, settings unrelated to MPX, and transcripts remain in place.

## Protected transactions

Private recovery pointers now live under
`${MPX_APPS}/_backups/mpx-cleanup-retained/local-evidence/`, moved intact from canonical `.local/`:

- `native-name-cutover-pointer.json`: configuration and native registration naming migration.
- `location-cutover-pointer.json`: canonical checkout routing switch.
- `final-cutover-pointer.json`: earlier installed-runtime retirement.
- `legacy-archive-pointer.json`: archived installations.
- `legacy-preservation-pointer.json`: Git bundles and full Git snapshots, including stashes and reflogs.

These pointers and their private artifacts must not be published. Referenced backup directory names
and contents remain unchanged. The retained evidence has a sibling `local-evidence.sha256.json`
inventory. Historical account evidence also remains with the retained source checkout. See
[the cleanup checklist](../CLEANUP.md) before retiring either copy.

## Recovery order

1. Stop affected agents and preserve newer configuration changes.
2. Review the naming transaction first, then the location transaction. Evidence was relocated;
   inspect any embedded original paths before using the retained scripts. Their recovery defaults to
   preview; mutation requires explicit `--apply`.
3. Coordinate source-version rollback with configuration and registration rollback. Current code
   expects `$APPDATA/mpx/config.json`, Pi `extensions/mpx.ts`, and Claude `rules/mpx`; restoring only
   old names does not make current code compatible with them.
4. Inspect older transaction targets before considering further recovery. Never restore whole native
   account directories over newer credentials or conversations.

Drift refusal requires inspection, not forced replacement. Preserve protected artifacts until
restart/resurrection acceptance passes. The original personal pilot has a concurrency limitation:
its recovery can remove a file changed after validation. Do not automate that older recovery while
sessions or editors can still write its targets.

## Acceptance boundaries

Personal Claude authentication is an accepted exception while its subscription is inactive.
Configuration, executable, hook, and launch checks still apply. Marker probes do not establish
unrestricted tools, saved Claude effort, desktop notifications, or physical restart behavior.
