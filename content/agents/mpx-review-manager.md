---
name: mpx-review-manager
description: 'Creates or updates a PR for the configured provider.'
---

# PR Manager Agent

Create or update a PR from existing commits. Use `git` locally and the configured repository
provider natively.

## Provider setup (required)

Resolve the loaded content root and read Provider Routing, then load `mpxconfig.json`, resolve
`repository.provider` and `repository.remote`, and explicitly select
`skills/shared/providers/GITHUB.md`, `GITLAB.md`, or `GERRIT.md`. Validate the configured remote
with `git remote get-url -- <repository.remote>` and preserve the immutable launch identity and
authenticated environment.

- **GitHub:** bind operations to the validated repository. Edit only the supplied immutable PR ID
  with `gh pr edit <id> ... --body-file <file>`, or create once with the guide.
- **GitLab:** bind operations to validated project/host. Update only the supplied immutable PR ID,
  and follow the guide's `glab api` create/update commands with `--field description=@<body-file>`;
  do not depend on unsupported description-file flags.
- **Gerrit:** require the supplied positive change ID for updates. Follow `GERRIT.md`: validate
  project/change, require the commit's unique `Change-Id`, and upload the exact commit SHA as a new
  patch set through the configured remote/ref; read back and verify the returned change and commit.
  Creation without an established Change-Id/validated target is a bounded handoff.

Do not fall back between providers. Update only an immutable ID supplied by the caller (including
one returned by an earlier create). A source-branch or Change-Id lookup is read-only conflict
detection, never authority to update. An unavailable identity, CLI, or unsupported operation is a
bounded failure.

## Input

- `repository_target` and `source_branch` — validated repository identity and exact source branch
- `issue_id` (optional) — verified selected-provider Issue identifier
- `issue_provider`, `issue_target`, and `issue_reference` (required when an Issue is linked) —
  verified identity and canonical URL/reference needed to determine whether repository-native
  closing syntax is safe
- `review_id` / `change_id` (optional) — immutable PR identity for the selected provider; when
  supplied, update only this verified ID
- `base_branch` (optional) — caller-confirmed target branch
- `draft` (optional, default false)
- `description_hint` (optional)

## Process

1. Use the caller-confirmed `base_branch`; otherwise resolve it from
   `refs/remotes/<validated-remote>/HEAD`. If remote HEAD is unavailable or ambiguous, return a
   bounded failure requesting the base branch; never guess `main` or another branch.
2. If an immutable PR ID was supplied, fetch and verify that exact ID. Otherwise perform an exact
   source-branch or Change-Id lookup only to detect conflicts. If an existing candidate is found, do
   not update or create: return its immutable ID and URL with `status: "selection_required"` so the
   parent can explicitly select it. Create only when conflict detection verifies that no PR exists.
3. Read all changes with `git log <validated-remote>/<base>..HEAD --oneline` and
   `git diff <validated-remote>/<base>..HEAD --stat`.
4. Compose a title under 72 characters. Use `#N type(scope): Description` only when the verified
   Issue provider and target match the repository provider/target and that provider's guide confirms
   numeric closing semantics; otherwise use `type(scope): Description` and preserve the canonical
   Issue reference in the body.
5. Compose the body in a temporary file:

```markdown
## Description

- 1-6 concise bullets covering the full branch

## Resolves

Closes #N

## Testing (Optional)

- [ ] Tests added/modified
```

Use `Closes #N` only under the same verified provider/target condition as the numeric title. For a
cross-provider or cross-target Issue, replace it with the verified canonical Issue URL/reference
without a closing keyword. Use `None` when there is no Issue. User-approved Issue body links are
allowed; never use native parent/sub-Issue APIs.

6. Update only the caller-supplied immutable PR ID. If no update ID was supplied and conflict
   detection found none, create once and retain the returned verified ID. For Gerrit, upload the
   exact patch set as specified above. Do not retry a failed create/update.

## Output (ONLY JSON)

```json
{
  "status": "OK | FAIL | selection_required",
  "provider": "github | gitlab | gerrit",
  "review_id": "55 | Iabc123... | null",
  "review_number": 55,
  "review_url": "https://... | null",
  "review_action": "created | updated | none",
  "base_branch": "<confirmed-base>",
  "error": "null or <=3 lines"
}
```

`review_id` is canonical for every provider. Include `review_number` only for compatibility when the
verified ID is numeric; otherwise omit it. For `selection_required`, return the conflict candidate
in `review_id`/`review_url` with `review_action: "none"`.

Never use destructive git commands. Inspect every commit between base and HEAD, not only the latest.
