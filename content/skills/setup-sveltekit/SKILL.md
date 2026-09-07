---
name: setup-sveltekit
description: Create a SvelteKit project from an authorized template with Review and CI policy
triggers: setting up a SvelteKit repository
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: explicit-only
---

# Setup SvelteKit

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

## Workflow

1. Collect project name and visibility, defaulting to private. Preserve privacy: do not echo tokens, private content, or unrelated machine paths.
2. Discover the authorized `template-sveltekit` project configuration and intended destination without installing dependencies or mutating a provider. Run `mpx --cwd <discovered-project-path> doctor --json`. Stop on an error diagnostic; record warnings and continue only when remediation is understood.
3. Create the repository through the selected provider's installed, provider-resolved template capability. If the selected provider has no native template capability, stop remote creation with structured remediation; do not invent an MPX command.
4. Create and push `dev` with ordinary `git -C <project-path>`. Set the default branch and request protection for `main` and `dev` through the selected provider's supported provider-resolved operations, requiring Review integration and CI. Protection failure is graceful: record each branch and complete error, continue, and report it unprotected.
5. Install with pnpm and run the template checks and tests. Keep command/output evidence. Continue only if failures are recorded and confirmed not to prevent setup.
6. Ask whether to add Svelte MCP support; run the repository-supported setup only after consent.
7. Initialize canonical `.mpx` documentation without replacing substantive files. Verify portable user-level Svelte rules and provide a manual handoff when absent.
8. Commit and push authorized changes. Report URL, default branch, protection, checks, MCP choice, rules, and exceptions.

GitHub and GitLab capability implementations may differ but remain provider-resolved. When a capability is unsupported, preserve local work and return structured remediation; do not fall back to a provider CLI.
