---
argument-hint: "[PR ID or URL] [draft] [base branch] [commit or description hint]"
description: Loads the mp-commit-push-pr skill when explicitly referenced.
metadata:
  author: MartinoPolo
  category: git-workflow
  version: "0.6"
name: mp-commit-push-pr
triggers: committing, pushing, and publishing a PR together
---

# Commit, Push, and Create or Update a PR

Run the shared commit workflow phases in order. `the invocation input`

Before a provider command, read [Provider Routing](../../../../../pi/instructions/shared/PROVIDER_ROUTING.md), load
`mpxconfig.json`, resolve `repository.provider`, and read its native guide in
the provider guides linked there. Use only documented native commands and preserve the native CLI
authentication environment. Native status/login diagnostics may inspect the active account, but do
not log in or out, substitute credentials, or switch accounts.

## Workflow

1. Read [Git Commit Workflow](../../../../../pi/instructions/shared/GIT_COMMIT_WORKFLOW.md).
2. Run **Phase A** through `mpx-git-committer` with `push: true` and
   `commit_hint: the invocation input`. On `SKIP` for nothing to commit, verify the branch is
   already pushed before continuing.
3. Run **Phase B** exactly as defined by the shared workflow. Do not duplicate Issue discovery in
   this skill.
4. Run **Phase C** through `mpx-review-manager`, passing any explicit PR ID or URL, requested base
   branch, `draft: true` when requested, and the invocation input or Phase A summary as the
   description hint. The shared workflow owns PR identity, title, and body handling.
5. Preserve Phase A and Phase C structured results and escalation. Diagnose failures in the parent
   and retry the same bounded agent request up to twice. Never switch the active account or environment, use
   undocumented actions, or claim failed push or publication succeeded.

Use provider vocabulary at the command boundary while reporting the result as a PR.

## Output

- Commit hash and message, when committed
- Push status
- Base branch used
- PR URL and provider number/IID
- Whether created or updated, and draft state
- Steps skipped, if any
