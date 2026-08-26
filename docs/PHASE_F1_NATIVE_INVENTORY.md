# Phase F1 native account capability inventory

This is a read-only, fail-closed comparison of installed Claude/Pi package metadata against [`phase-f1-capability-declarations.json`](phase-f1-capability-declarations.json). It does not install, copy, migrate, enable, disable, or authenticate anything.

## Privacy boundary

`scripts/native-capability-inventory.mjs` reads only these allowlisted files beneath explicitly designated native runtime roots:

- Claude: `plugins/installed_plugins.json` (schema version 2) and each in-root installed plugin's `plugin.json`;
- Pi: the root `package.json` and package manifests named by its `dependencies`/`devDependencies` beneath `node_modules`.

It emits only identity labels, runtime, package/plugin IDs, exact installed version identifiers, capability route **names**, redacted root-relative source placeholders, and SHA-256 root digests. It never emits an absolute native path or account ID. Unknown keys/schema versions, unsafe version identifiers, oversized files, path escapes, symlinks anywhere in an allowlisted path, changed file identities, and path replacement fail closed. An indexed Claude installation whose exact manifest is absent is retained as `unsupported` with reason `METADATA_UNAVAILABLE`; the collector does not search for an alternative.

The collector has no directory scan. It never names or opens `auth.json`, credentials, tokens, environment secret values, sessions, history, transcripts, trust decisions, caches other than the specific Claude installed-plugin path named by its allowlisted index, databases, keyrings, or arbitrary settings/config. Root discovery is limited to `identities.*.runtimeRoots` in the established `%APPDATA%/mpx/config.json` identity route, or explicit `--root` arguments. `MPX_PROJECTS`, `MPX_WORK`, and the other machine-domain variables are not native account roots and are never searched for one.

## Classification

- `matched`: ID, exact version, and sorted declared route names equal the repository declaration.
- `missing`: a repository declaration has no installed metadata entry.
- `extra`: installed metadata has no repository declaration.
- `unsupported`: the ID exists but its exact version or declared routes differ.

## Manual collection

After the user-local MPX identity config exists, run exactly:

```powershell
node scripts/native-capability-inventory.mjs --config "$env:APPDATA\mpx\config.json" > "$env:TEMP\mpx-phase-f1-native-inventory.json"
```

Review the temporary JSON for placeholders only before selectively committing evidence. Do not redirect it into the native root or commit it without privacy review. Explicit roots are supported when already designated by the user, using repeated `--root "personal:claude:C:\designated\root"` / `--root "work:pi:C:\designated\root"`; do not derive these by home-directory scanning.

## Current execution evidence

A live collection used four explicit, user-designated personal/work Claude and Pi roots; no root was discovered or inferred. All four roots passed the allowlisted schema parser. Deterministic duplicate removal reduced repeated index observations to 0 matched, 2 missing repository packages, 16 extra native installations, and 3 unsupported indexed Claude installations whose exact manifests were unavailable. The declared MPX runtime packages remain absent as expected Phase I installation evidence rather than being represented as already installed. No native state was copied or modified.

The declarations schema records a reviewed disposition, phase, rationale, and intended MPX route for every observed package ID. External native providers are preserved, canonical behavior is routed to repository content, install-time replacements remain explicitly Phase I, and missing exact Claude manifests stay unsupported without widening reads. The privacy-reviewed result is [`history/PHASE_F1_NATIVE_INVENTORY_EVIDENCE.json`](history/PHASE_F1_NATIVE_INVENTORY_EVIDENCE.json). It contains only root placeholders and SHA-256 digests, classifications, reviewed dispositions, package IDs, exact versions, named routes, sanitized source placeholders, capture and declaration metadata, and collector/evidence hashes. Sanitized fixtures mirror the observed Claude v2 and Pi npm structures; tests cover path escape, unknown schema, missing exact manifests, deterministic deduplication, and symlink rejection, while the collector retains its file-size and path-identity controls.
