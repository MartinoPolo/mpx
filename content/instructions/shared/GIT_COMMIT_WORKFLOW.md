# Git Commit Workflow

Single source of truth for staging, commit wording, optional push, linked Issue discovery, and PR creation or
update.

## Phase A: commit and optional push

Spawn `mpx-git-committer` with a bounded `push` boolean and optional commit hint. Parse its structured result:

- `OK`: continue or report the commit;
- `SKIP`: report a clean tree or already-up-to-date remote;
- `FAIL`: the parent diagnoses the exact failure and may retry the same bounded request twice.

Do not delegate failure diagnosis back to the committer.

## Phase B: linked issue

Extract an Issue identity from the branch using the repository's configured extraction command, if present. Verify every
candidate through the selected Issue interface: its native provider guide's explicit-target view command, or the
selected typed MPX Issue view command.

If extraction finds nothing, spawn `mpx-issue-finder` with the branch name, commits, diff summary, selected Issue
interface, and validated target. A high-confidence match continues automatically. Present multiple candidates to the
user. Continue without an Issue when none matches; never invent a reference.

## Phase C: create or update review

Spawn `mpx-review-manager` using the selected repository guide or the explicitly selected typed `Review` interface. Supply
the validated repository target, source and target branches, optional verified Issue ID, draft state, and description
hint.

Create a PR only when no immutable update ID was supplied. Update only the exact immutable PR ID supplied
to the manager or returned by an earlier create; never discover an update target implicitly. Capture and return the
immutable ID and URL from structured native output or the typed response.

Unsupported creation, update, or fields produce a manual handoff under [ISSUE_TRACKER.md](ISSUE_TRACKER.md); do not
invent a provider command. On operational failure, the parent may diagnose authentication, remote, or target-branch
problems and retry the same bounded operation twice.

## Commit conventions

1. Inspect `git status --short` plus staged and unstaged diffs.
2. Stage explicit paths for one logical change. Split unrelated work.
3. Follow repository policy; otherwise choose a lowercase conventional type: `feat`, `fix`, `docs`, `style`, `refactor`,
   `perf`, `test`, `build`, `ci`, `chore`, or `revert`.
4. Write the message to a temporary file and run `git commit -F <file>`.
5. Report hash, subject, and `git show --stat --oneline HEAD` evidence.

```text
<type>[(scope)][!]: <imperative subject>

<body explaining motivation, impact, or context when useful>

MPX-Session: <session-reference>
```

Keep the subject concise, imperative, and specific. Use `!` only for a breaking change. Omit a body that merely restates
the diff; otherwise explain why the change is needed and any non-obvious behavior or trade-off. Add the `MPX-Session`
trailer only when the runtime supplies an approved non-secret reference. Append only a verified, tracker-neutral
`issue_ref` supplied by the workflow.

## Safety

- Stage explicit paths; never stage the whole tree implicitly.
- Never stage environment files, credentials, secrets, private keys, or certificates.
- Prefer a new commit. Amend only on explicit request.
- Do not hard reset, rewrite history, or force-push.
- Merge and submit require fresh human authorization in the selected provider guide.
