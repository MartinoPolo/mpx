# Changelog

## Unreleased

### Added

- Machine-local project configuration fallbacks and explicit acceptance of missing project metadata.
- Minimal project configs for ordinary folders, with independently optional repository and Issue roles.
- Escape cancellation at the launch-warning prompt.
- Distinct account-ownership, project-configuration, and skill-pack launch warnings with severity colors.

### Fixed

- Pi idle cancellation now exposes explicit stop intent before native cancellation, preventing
  cancellation-aware background recovery from restarting a stopped parent.
- Background subagent results use event-driven joins and quiet receipt-based recovery instead of
  delayed completion previews. Native saved child context supports explicit continuation after reload.
- Child sessions exclude parent-only Orca hooks before loading; explicit model overrides and bounded
  grandchildren retain inherited tool restrictions, including on resumed runs.

### Changed

- Warning output keeps severity colors without redundant color-name prefixes.
- Every launch warning requires acknowledgement before starting the native terminal UI.
- Recursive personal/work domain checks cover both the current directory and the Git main checkout.
- Invalid project configuration is no longer also reported as missing or unregistered.
