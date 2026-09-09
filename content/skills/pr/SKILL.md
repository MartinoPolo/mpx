---
name: pr
description: Create or update a pull request (PR), or GitLab merge request (MR), from existing commits
argument-hint: '[PR or MR ID or URL] [draft] [base branch] [description hint]'
triggers: publishing committed branch changes for review
metadata:
  author: MartinoPolo
  version: '0.6'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Create or Update a PR

Create or update a PR (GitLab MR) from commits already on the current branch. `the invocation input`

Before a provider command, read [Provider Routing](../shared/PROVIDER_ROUTING.md), load `mpxconfig.json`, resolve
`repository.provider`, and read its native guide in `../shared/providers/`. Use only documented native commands and
preserve the immutable launch identity and account-bound CLI environment. Resolve Markdown links relative to this
compiled skill; when a literal absolute content path is required, follow [Content Paths](../shared/CONTENT_PATHS.md)
using the validated `MPX_ACTIVE_CONTENT_ROOT`, without fallback-root searches or guessed checkouts.

## Workflow

1. Read [Git Commit Workflow](../shared/GIT_COMMIT_WORKFLOW.md). Phase A does not apply because commits already exist.
2. Run **Phase B** exactly as defined by the shared workflow.
3. Run **Phase C** through `mpx-review-manager`, passing any requested base branch, draft state, description hint, and
   explicit PR/MR ID or URL.
4. Select update identity explicitly. An ID or URL supplied by the caller is immutable. Without one, the manager may
   perform a read-only lookup and present the current branch's PR/MR, but update it only after that exact identity is
   selected; otherwise create a PR/MR. Never infer or replace an update target during mutation.
5. Preserve the manager's structured result handling and escalation. On failure, diagnose authentication, remote, or
   base-branch problems without changing identity or environment, then retry the same bounded request up to twice. If it
   still fails, report the exact error and stop.

Use `PR` as the user-facing convention and `MR` when clarifying GitLab behavior. Keep provider commands, agent names,
and structured fields such as `review_id` unchanged.

## Output

- Base branch used
- PR/MR ID and URL
- Whether created or updated
- Draft state
