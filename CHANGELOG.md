# Changelog

## Unreleased

### Added

- Machine-local project configuration fallbacks and explicit acceptance of missing project metadata.
- Minimal project configs for ordinary folders, with independently optional repository and Issue roles.
- Escape cancellation at the launch-warning prompt.
- Distinct account-ownership, project-configuration, and skill-pack launch warnings with severity colors.

### Changed

- Warning output keeps severity colors without redundant color-name prefixes.
- Every launch warning requires acknowledgement before starting the native terminal UI.
- Recursive personal/work domain checks cover both the current directory and the Git main checkout.
- Invalid project configuration is no longer also reported as missing or unregistered.
