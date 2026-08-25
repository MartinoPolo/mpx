# Git Commit Workflow

Single source of truth for staging, commit wording, optional push, linked MPX Issue discovery, and
MPX Review creation.

## Phase A: commit and optional push

Spawn `mpx-git-committer` with a bounded `push` boolean and optional commit hint. Parse its
structured result:

- `OK`: continue or report the commit;
- `SKIP`: report a clean tree or already-up-to-date remote;
- `FAIL`: the parent diagnoses the exact failure and may retry the same bounded request twice.

Do not delegate failure diagnosis back to the committer.

## Phase B: linked issue

Extract an issue identity from the branch using the repository's configured extraction command, if
one exists. Verify a candidate with
`mpx issue view --identity <launch-identity> --json --id <issue-id>`. If extraction finds nothing,
spawn `mpx-issue-analyzer` or the configured bounded issue finder with branch name, commits, and a
diff summary.

A high-confidence match continues automatically. Present multiple candidates to the user. Continue
without an issue when none matches; never invent a reference.

## Phase C: create or update review

Use `mpx review create` or `mpx review update` with `--identity <launch-identity> --json`, explicit
source/target branches, optional issue ID, draft state, and description hint. Capture the returned
review ID and URL from structured output. Unsupported review creation or fields produce a manual
handoff under [ISSUE_TRACKER.md](ISSUE_TRACKER.md); do not call a provider CLI.

On operational failure, the parent may diagnose authentication, remote, or target-branch problems
and retry twice. Existing reviews are updated only when an explicit review ID was returned or
supplied; there is no implicit provider discovery.

## Commit conventions

1. Inspect `git status --short` and staged/unstaged diffs.
2. Stage explicit paths for one logical change. Split unrelated work.
3. Select a lowercase conventional type from the diff. Repository commit policy is authoritative;
   otherwise use `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
   or `revert`.
4. Compose the message in a temporary file and commit with `git commit -F <file>`.
5. Report hash, subject, and `git show --stat --oneline HEAD` evidence.

```text
<type>[(scope)][!]: <imperative subject>

<body explaining why, when needed>

MPX-Session: <session-reference>
```

Keep the subject concise and imperative. Use `!` only for a breaking change. Omit a body that adds
nothing; otherwise explain motivation rather than restating the diff. Add the `MPX-Session` trailer
only when the runtime supplies an approved non-secret session reference.

Issue references are tracker-neutral and parameter-driven. Append only a verified `issue_ref`
provided by the workflow.

## Safety

- Stage explicit paths; never stage the entire tree implicitly.
- Never stage environment files, credentials, secrets, private keys, or certificates.
- Prefer a new commit. Amend only on explicit request.
- Do not hard reset, rewrite history, or force-push in this workflow.
