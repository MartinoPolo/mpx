---
name: ship
description: Ship intended work through commit, push, native PR, CI, and authorized merge
argument-hint: '[base-branch] [--no-auto-merge]'
metadata:
  author: MartinoPolo
  version: '0.8'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Ship

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable.
Prepare a substantive summary of the intended change before delivery. Read
[Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md). Publication requires a valid
configured `repository.provider`; resolve it and load only its selected native guide. Invocation
authorizes merge unless `--no-auto-merge` is present. Resolve the current source branch and pass it
explicitly to `mpx-shipper`. Invoke `mpx-shipper` with endpoint `merge`, the explicit intended paths, summary and
`the invocation input`, actual target branch when supplied, configured remote and validated
repository target, verified Issue identity/link when any, existing immutable PR/change and CI
identities, repository merge policy, merge authorization, and `no_auto_merge` state.

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
For each accepted implementation, hook, push, PR, mergeability, or CI repair, dispatch a fresh
`mpx-executor` with the requirements, precise repair objective, file pointers, acceptance criteria,
and verification commands. Tell it to inspect the current diff and relevant files. Verify the
repair before invoking the shipper again. The shipper never repairs.
For CI repairs, supply the validated repository, PR, branch, commit, and failing run/job identities.

Without `--no-auto-merge`, completion requires provider-confirmed merge. With it, completion is green
CI with the explicit PR still open.

Report actual results after delivery, including completed stage, commit/branch/repository/PR/run
identities, CI and merge state, excluded artifacts, attempts,
remaining work, and blockers.
