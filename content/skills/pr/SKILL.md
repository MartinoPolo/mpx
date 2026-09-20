---
name: pr
description: 'Commit and push intended changes, create or update a draft PR, and monitor CI.'
argument-hint: '[PR or MR ID or URL] [base branch] [commit or description hint]'
triggers: committing, pushing, and publishing a draft PR together
metadata:
  author: MartinoPolo
  version: '0.8'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Publish a Draft PR

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable.
Prepare a substantive summary of the intended change before delivery. Read
[Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md). Publication requires a valid
configured `repository.provider`; resolve it and load only its selected native guide. Resolve the
current source branch and pass it explicitly to `mpx-shipper`. Invoke `mpx-shipper` with endpoint
`pr`, the explicit intended paths, summary and `the invocation input`, actual target branch when
supplied, `draft: true`, configured remote and validated repository target, verified Issue
identity/link when any, and an explicit immutable PR/change ID when updating.

Resolve `issues.provider` only when verifying an explicit Issue reference or performing optional
discovery when an Issue tracker is configured. Extract and verify an explicit Issue reference first.
An explicit Issue reference with missing or invalid Issue configuration blocks the Issue-linking
branch for user resolution; do not silently discard it or publish as though no Issue was supplied.
With no explicit reference, dispatch `mpx-issue-finder` only when an Issue tracker is configured.
Ask the user to select among ambiguous candidates, and continue without an Issue when none is found.
If there is no explicit Issue reference and no configured Issue tracker, continue without an Issue
and do not dispatch `mpx-issue-finder`; never infer or synthesize an Issue provider. For an existing
PR, preserve its queried target unless repository policy or an authorized update selects another
target.

The parent owns **three total shipping attempts: the initial attempt plus two retries across all
stages and any continuation**. Never reset this budget or replace identities established by an
earlier attempt. On failure, evaluate the bounded evidence.
For accepted implementation, hook, push, PR, or CI repairs, dispatch a fresh `mpx-executor` with the
requirements, precise repair objective, file pointers, acceptance criteria, and verification
commands. Tell it to inspect the current diff and relevant files. Verify the repair before invoking
the shipper again. The shipper never repairs.
For CI repairs, supply the validated repository, PR, branch, commit, and failing run/job identities.

Completion requires a verified commit and push, an explicit **draft** PR identity, and terminal CI
status. When reusing a ready PR, check its state and selected-provider policy; do not claim draft or
silently downgrade it without authorization. Return a blocker when the requested draft state cannot
be achieved. Failed CI is reported as remaining work, not success. Human controls readiness for review.
Report actual results after delivery, including commit/branch/repository/PR/run identities, target,
CI state, excluded artifacts, retries, remaining work, and blockers.
