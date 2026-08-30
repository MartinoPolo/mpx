---
name: repository-setup
description: Initialize a local repository and request provider repository policy capabilities
triggers: initializing and publishing a new repository
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: explicit-only
---

# Repository Setup

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Abort if `.git/` exists. Initialize deterministic ignore, attributes, editor, root instructions, and local Git metadata. Preserve substantive existing files.
2. Create `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` from canonical project scaffolds only when missing or untouched, then commit documentation separately.
3. Ask privacy visibility; private is the recommended default. Never expose repository contents or credentials while reporting.
4. Rename the stable branch to `main` where needed. Request `mpx tool invoke --capability repository.create --identity <launch-identity> --json` with name, visibility, source, and push intent. Capture the repository URL.
5. Create and push `dev` with ordinary `git`. Request `mpx tool invoke --capability repository.default-branch --identity <launch-identity> --json` for `dev`.
6. For `main` and `dev`, request `mpx tool invoke --capability repository.protection --identity <launch-identity> --json` requiring Review integration and CI checks with no mandatory approver unless repository policy says otherwise.
7. Report local files, URL, branches, default branch status, and protection state per branch.

## Provider capability branches

- If provider is GitHub, use its launch-bound repository creation, default branch, and branch protection capabilities.
- If provider is GitLab, use equivalent launch-bound project creation/default branch/protected branch capabilities when advertised.
- For an unsupported provider or missing capability, expect `CAPABILITY_UNSUPPORTED` with structured remediation. Do not fall back to a provider CLI. Preserve local initialization and give a manual handoff.

Protection failure is graceful: record the complete structured error and unprotected branches, continue safe independent setup, and never report protection as applied. Repository creation failure stops remote steps.
