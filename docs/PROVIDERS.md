# Provider contracts

Provider selection is configuration-driven and backed by a trusted code registry. Project configuration cannot define executable paths or command templates.

Built-in repository providers are GitHub, GitLab, Gerrit, and generic Git. Built-in Issue providers are GitHub, GitLab, KanbanFlow, local filesystem, and none. Their trusted backends remain `gh`, `glab`, Git plus SSH, `kf`, filesystem, and none.

Provider descriptors declare granular Issue, Review, and CI capabilities. Unsupported capabilities return `CAPABILITY_UNSUPPORTED` through the standard versioned error envelope; callers must not fall back to direct provider commands.

```bash
mpx provider list --json
mpx provider explain repository --cwd . --json
mpx provider explain issues --cwd . --json
```

Authentication remains in each provider's native credential store. MPX diagnostics may report redacted presence, host, and account labels but never token values.
