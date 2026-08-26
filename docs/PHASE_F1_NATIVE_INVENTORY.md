# Phase F1 native account capability inventory

This is a read-only, fail-closed comparison of installed Claude/Pi package metadata against [`phase-f1-capability-declarations.json`](phase-f1-capability-declarations.json). It does not install, copy, migrate, enable, disable, or authenticate anything.

## Privacy boundary

`scripts/native-capability-inventory.mjs` reads only these allowlisted files beneath explicitly designated native runtime roots:

- Claude: `plugins/installed_plugins.json` (schema version 2) and each in-root installed plugin's `plugin.json`;
- Pi: the root `package.json` and package manifests named by its `dependencies`/`devDependencies` beneath `node_modules`.

It emits only identity labels, runtime, package/plugin IDs, exact versions, capability route **names**, redacted root-relative source placeholders, and SHA-256 root digests. It never emits an absolute native path or account ID. Unknown keys/schema versions, non-exact versions, oversized files, path escapes, symlinks anywhere in an allowlisted path, changed file identities, and path replacement fail closed.

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

On this branch, `%APPDATA%/mpx/config.json` was unavailable. Live collection therefore did **not** run, no native account root was opened, and no native state was copied. The checked-in redacted result is [`history/PHASE_F1_NATIVE_INVENTORY_EVIDENCE.json`](history/PHASE_F1_NATIVE_INVENTORY_EVIDENCE.json). Fixtures cover successful comparison and fail-closed schema/symlink handling.
