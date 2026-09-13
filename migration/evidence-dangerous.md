# Dangerous-command safeguard evidence

## Scope and execution settings

Implemented only the shared policy and its focused tests/evidence. No Claude/Pi transport, CLI, account, shell, or registration files were changed, and no commit was made.

Execution settings reported by Pi for this task:

- `PI_MODEL=gpt-5.6-sol`
- `PI_PROVIDER=openai-codex`
- `PI_REASONING_LEVEL=high`
- `PI_SESSION_FILE=` (unset/empty)
- Platform: Windows 11, Git Bash command surface

Owned files:

- `src/safeguards/dangerous.ts`
- `test/dangerous.test.ts`
- `migration/evidence-dangerous.md`

## Shared contract

`evaluateDangerousCommand(command, cwd)` is asynchronous and returns the shared `PolicyResult` shape (`allow` or `block` plus diagnostics). It statically inspects command text and never executes that text. Git is invoked only with bounded, read-only local metadata queries needed for default-branch detection; each query has a 2-second timeout.

`isWindowsNulFileTarget(target)` is a pure path predicate intended for thin edit/write/patch transports as well as shell redirection policy. It recognizes case-insensitive `NUL` reserved-device basenames, including nested paths and extension forms.

## Policy evidence

Focused fixtures cover:

- non-recursive deletion, empty-directory removal, and recursive deletion without force as allowed operations;
- forced-recursive Bash, PowerShell, and cmd deletion, including flag order, multiple targets, generated/cache ancestry, explicit temp/scratch roots, traversal, broad roots, dynamic targets, source/package/worktree targets, and mixed safe/unsafe lists;
- all mutating `git clean` forms blocked while `-n`/`--dry-run` forms remain allowed;
- repository-wide `find ... -delete` blocked while narrow relative non-force deletion remains allowed;
- raw force, force-with-lease, leading-`+` refspec, and mirror pushes to named or detected protected branches;
- force-with-lease to feature branches allowed;
- a real temporary Git repository with `refs/remotes/origin/HEAD` identifying a nonstandard default branch;
- failure of Git inspection blocking the affected force-push command while an unrelated command with the same unavailable cwd remains allowed;
- destructive SQL only for recognized `mysql`/`mariadb`, `psql`, `sqlcmd`, and SQLite executable argument forms, with quoted examples allowed;
- filesystem formatting, raw-device output/redirection, fork bombs, broad destructive chmod, and persistent Windows PATH mutation;
- NUL redirects in outer Git Bash, cmd, and PowerShell command text plus direct pure file-target checks;
- literal shell-wrapper recursion, opaque/dynamic interpreter fail-closed behavior, ordinary argument-variable use, malformed/oversized input, and non-execution of inspected text.

## Validation

Passed:

```text
pnpm exec tsx --test test/dangerous.test.ts
# 13 tests, 13 passed, 0 failed

pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node src/safeguards/dangerous.ts test/dangerous.test.ts
# exit 0
```

`pnpm run typecheck` passed on the first two runs during this task. A final rerun failed only in concurrently added, unowned `test/resume-launch.test.ts` at lines 49, 111, and 142 (`Array.map(JSON.stringify)` callback typing); the dangerous safeguard files produced no reported errors. That unowned file was not changed.

No destructive fixture command was run. Tests pass command strings to the evaluator; temporary test directories are created and removed through Node filesystem APIs. Git fixture setup uses only local repository metadata operations and does not push or clean.

## Honest limits and remaining acceptance

This is recognizable-accident prevention, not a shell parser, script sandbox, or authorization boundary. It handles simple Bash/Git-Bash command lists and recognizable PowerShell/cmd wrapper strings. Literal supported shell wrappers are recursively inspected; dynamic shell text, encoded PowerShell, dynamic executables, and inline general-purpose interpreter programs fail closed. Arbitrary script files are not opened or analyzed.

Generated/cache and scratch/temp safety is based on normalized lexical ancestry with explicit component names plus the operating-system temp root. Traversal, broad targets, and recognized source/package/worktree components do not become safe merely because a test repository is under the system temp directory. Repository-wide `find` detection intentionally targets broad/current/traversal starts and absolute repository roots rather than trying to model every `find` expression.

Default-branch detection is local and non-networking: remote symbolic HEAD refs, `init.defaultBranch`, and an unborn repository HEAD are recognized. The always-protected names are `main`, `master`, `dev`, and `prod`. The policy does not contact a hosting provider to infer a remote default absent local evidence.

Transport registration remains unverified and intentionally out of scope for these owned files. In particular, shell transports must call `evaluateDangerousCommand`, and non-shell file-writing transports must call `isWindowsNulFileTarget`. Installed interception in every launcher/account is still required before cutover and cannot be claimed from these unit tests.
