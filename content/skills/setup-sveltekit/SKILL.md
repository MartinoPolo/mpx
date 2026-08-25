---
name: setup-sveltekit
description: Create a SvelteKit project from an authorized template with Review and CI policy
triggers: setting up a SvelteKit repository
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: explicit-only
---
# Setup SvelteKit

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Collect project name and visibility, defaulting to private. Preserve privacy: do not echo tokens, private content, or unrelated machine paths.
2. Request `mpx tool invoke --capability repository.template-create --identity <launch-identity> --json` for `template-sveltekit`. If the selected provider has no native template capability, stop remote creation with structured remediation.
3. Create and push `dev` with ordinary `git -C <project-path>`, then request `mpx tool invoke --capability repository.default-branch --identity <launch-identity> --json`.
4. Request `mpx tool invoke --capability repository.protection --identity <launch-identity> --json` on `main` and `dev`, requiring Review integration and CI. Protection failure is graceful: record each branch and complete error, continue, and report it unprotected.
5. Install with pnpm and run the template checks and tests. Keep command/output evidence. Continue only if failures are recorded and confirmed not to prevent setup.
6. Ask whether to add Svelte MCP support; run the repository-supported setup only after consent.
7. Initialize canonical `.mpx` documentation without replacing substantive files. Verify portable user-level Svelte rules and provide a manual handoff when absent.
8. Commit and push authorized changes. Report URL, default branch, protection, checks, MCP choice, rules, and exceptions.

GitHub and GitLab capability implementations may differ but remain launch-bound. On `CAPABILITY_UNSUPPORTED`, do not fall back to a provider CLI; preserve local work and return structured remediation.
