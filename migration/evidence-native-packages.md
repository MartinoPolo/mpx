# Native package evidence

Date: 2026-09-13

## Result

The read-only inspection and isolated native Pi 0.85.1 probe passed for all six configured package/account pairs. No package was installed, updated, or removed.

| Capability | Personal | Work | Probe result |
|---|---:|---:|---|
| `pi-web-access` | 0.28.0 | 0.27.0 | Four tools loaded with the same contract shape; loopback fetch was blocked by SSRF policy and the server received 0 requests. |
| `pi-mcp-adapter` | 2.32.1 | 2.32.1 | Native `mcp` tool loaded; isolated dummy stdio server echoed `probe:hello`. |
| `@juicesharp/rpiv-ask-user-question` | 2.9.0 | 2.9.0 | Select, custom-answer, cancel, and headless-rejection callback paths passed. |

The expected web-version mismatch remains: personal 0.28.0 versus work 0.27.0. The retained MCP and question-package versions also remain exactly as found above; no arbitrary upgrades were performed.

## Native settings-source path proof

The probe read these exact configured strings from each account's `settings.json`:

- `npm:pi-web-access`
- `npm:pi-mcp-adapter`
- `npm:@juicesharp/rpiv-ask-user-question`

It then supplied each account's three exact strings to an in-memory `SettingsManager` and called the public, read-only `DefaultPackageManager.listConfiguredPackages()` with that account root as `agentDir`. All six `installedPath` results matched the independently inspected paths:

- Personal: `C:\Users\snapy\.pi\agent\npm\node_modules\<package-name>`
- Work: `C:\Users\snapy\.pi\agent-work\npm\node_modules\<package-name>`

This follows the installed Pi 0.85.1 implementation in `node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js`:

- lines 1148-1159 recognize `npm:`, strip it, and parse the npm package name (including scoped names);
- lines 740-750 have `listConfiguredPackages()` pass each user settings source to `getInstalledPath()`;
- lines 666-670 parse the source, choose the npm path resolver, and only return an existing path;
- lines 1723-1731 build a user managed path as `agentDir/npm/node_modules/source.name`;
- lines 1741-1747 retain that managed path when it exists, so none of these six lookups reaches the legacy global npm fallback.

The probe did not call `resolve()`, `install()`, or any missing-package/installing resolver on either real account root. `additionalExtensionPaths` was used only afterward to verify loading and behavior from the already native-resolved directories; it is not presented as the settings-source path proof.

## Command and boundaries

Executed successfully:

```text
node --import tsx migration/native-packages-probe.mjs --personal-root C:/Users/snapy/.pi/agent --work-root C:/Users/snapy/.pi/agent-work
```

Each package ran in a disposable fixture with isolated home/config/temp paths, an in-memory credential store, offline/version-check flags, and credential-like environment variables removed. The web check used only a loopback server, and MCP used only a generated dummy stdio server.

These are loader and headless/RPC callback tests. They do not establish human terminal-UI acceptance, external provider behavior, authenticated service behavior, or real credential-store integration.
