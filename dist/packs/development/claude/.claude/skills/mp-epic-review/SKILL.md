---
description: Review a completed Epic across code, architecture, cleanup, documentation, and unresolved work, then...
disable-model-invocation: true
metadata:
  author: MartinoPolo
  category: project-management
  version: "1.9"
name: mp-epic-review
triggers: end-of-Epic review and optional accepted fixes
---

# Epic Review

Argument: explicit Epic number or URL. Use compressed orchestration output; use normal professional
prose in the phase-end document and user summaries. Here, PR means a GitHub pull request, GitLab
merge request, or Gerrit change, as applicable.

## Content and provider discovery

Read [Issue tracker policy](../../../../../../claude/instructions/shared/ISSUE_TRACKER.md),
[provider routing](../../../../../../claude/instructions/shared/PROVIDER_ROUTING.md),
[sub-agent policy](../../../../../../claude/instructions/shared/SUBAGENT_PROTOCOL.md), [analysis branches](ANALYSIS_BRANCHES.md),
[execution](EXECUTION.md), and [phase-end template](PHASE_END_TEMPLATE.md). Read nearest valid
`mpxconfig.json`. Resolve `issues.provider` for Epic/child operations and `repository.provider`
independently for PR and CI. Read both selected shared provider guides and use their target-bound
native commands. Do not invent MPX facade actions or substitute one provider for the other.

## 1. Gather context

### Epic, children, and comments

Fetch the explicit Epic and all comments through the Issue provider. Parse only the deterministic
`## Child Issues` links in its body; fetch every listed child and its comments. Warn on open
children and continue because invocation is explicit. Validate reciprocal `## Epic` links and report
drift.

For GitHub, explicitly request comment reads with the guide's target-bound form:

```bash
gh issue view <number> --repo <target> --comments --json number,id,title,body,comments,labels,state,url
gh issue view <child> --repo <target> --comments --json number,id,title,body,comments,labels,state,closedAt,url
```

For KanbanFlow, use its native `issue view` result, including comments, and verify the configured
board before each read. Body links do not provide native hierarchy or automatic state sync.

### Pull requests, merge requests, and changes

Collect only PRs linked by confirmed Issue bodies/comments or commit evidence. Use the independently
selected repository provider. For GitHub:

```bash
gh pr view <review-number> --repo <target> --comments --json number,id,title,body,comments,url,state,mergedAt
```

For GitLab use the guide's target-bound `glab mr view` form and explicitly fetch all merge-request
notes through its documented API route. Never replace an explicit PR ID through branch discovery.
Collect bodies/comments needed for decisions and deferred work.

### Aggregate diff

Identify the earliest confirmed Epic-related commit. Validate the configured repository remote
before network access, then perform a concrete read-only fetch of the configured target branch and
retain the command/result as network evidence:

```bash
git remote get-url -- <configured-remote>
git fetch --no-tags <configured-remote> <configured-target-branch>
git log --oneline --all \
    --grep="refs #<first-child>" \
    --grep="fixes #<first-child>" \
    --grep="closes #<first-child>" \
    --format="%H"
git diff <base>..HEAD --stat
git diff <base>..HEAD
```

Require the single remote URL to match the selected repository guide's configured target before
fetching. The fetch must not push, alter authentication, or rewrite local branches. Use the
confirmed earliest commit's parent as `<base>`; do not assume grep order. If full diff exceeds
context, retain stat and let agents read changed files.

### Context slices

Build bounded slices:

| Branch                                  | Diff | Files   | Discussion                       |
| --------------------------------------- | ---- | ------- | -------------------------------- |
| spec alignment                          | full | changed | full authorized decision context |
| code quality / best practices           | full | changed | ~500-word decision digest        |
| security / performance / error handling | full | changed | none unless needed               |
| architecture                            | none | changed | architectural decisions          |
| cleanup                                 | full | changed | none                             |
| documentation                           | none | changed | full authorized build context    |
| unresolved                              | none | changed | all authorized Issue and PR text |

Exclude credentials, unrelated private discussion, and unnecessary personal data.

## 2. Run ten branches concurrently

Dispatch six named canonical agents: `mpx-reviewer-code-quality`, `mpx-reviewer-best-practices`,
`mpx-reviewer-spec-alignment`, `mpx-reviewer-security`, `mpx-reviewer-performance`, and
`mpx-reviewer-error-handling`. Each declares canonical review model policy; do not name vendor
models. Prompt each to review aggregate Epic changes and cross-PR patterns using its bounded slice.

Dispatch all four branches in [ANALYSIS_BRANCHES.md](ANALYSIS_BRANCHES.md). Gate: all ten return
required fields or an explicit no-findings result.

## 3. Synthesize

Merge duplicates, retaining strongest evidence. Classify Critical (must fix), Important (should
fix), or Minor (nice to have) across Code Quality, Architecture, Decomposition, Cleanup,
Documentation, and Unresolved Items. Write `.mpx/reviews/PHASE_END_EPIC_<id>.md` from
[PHASE_END_TEMPLATE.md](PHASE_END_TEMPLATE.md).

Gate: every finding appears exactly once, totals reconcile, every action has a checkbox, and
unresolved work has one disposition.

## 4. HITL gate

Show full document and say:

> Epic <ID> review complete. Found X critical, Y important, Z minor items across six categories.
> Confirm all, drop or edit named items, or defer everything; the document remains at
> `.mpx/reviews/PHASE_END_EPIC_<id>.md`.

Wait. Never execute automatically.

## 5. Execute and close out

After response, follow [EXECUTION.md](EXECUTION.md). Continue only when every accepted finding is
checked off or explicitly deferred and Epic state is reported.

## Provider limitations and evidence routing

- Issue bodies/comments/labels/closure route through `issues.provider`; PRs and provider CI route
  through `repository.provider`; local Git diff remains repository evidence.
- GitHub uses `gh`; GitLab uses `glab`; Gerrit uses its guide's Git/SSH change reads. Mixed
  providers are valid and must remain separate.
- Gerrit CI is unsupported: record the missing CI evidence and an exact manual handoff, while
  continuing supported Gerrit change reads, Issue-provider reads, and local analysis. An unsupported
  repository role must not block independent Issue-only work.
- KanbanFlow is an Issue provider only and provides no PR or CI; those operations still use the
  independent repository provider. An unsupported Issue provider or unavailable operation marks
  only that evidence unavailable; continue independent supported operations and local analysis and
  return exact manual retrieval steps.
- Never infer native parentage from provider search. Deterministic Epic body links are authoritative
  only after reciprocal validation.
- Record commands, IDs, resolved provider guides, model-class resolution evidence when available,
  unavailable evidence, and every manual handoff.
