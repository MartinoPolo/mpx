---
name: execute
description:
  Execute one Issue or inline work end to end with TDD, code review, PR, CI, and default merge
argument-hint: '[issue|inline/checklist] [--full-review|--no-auto-merge]'
metadata:
  author: MartinoPolo
  version: '2.10'
  category: project-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: normal
---

# Execute Work

Unified execution for a single Issue or inline tasks. Invocation explicitly authorizes the original
end-to-end defaults: implement, commit, push, create/update a PR, GitLab MR, or Gerrit change, wait
for CI, and merge after green unless `--no-auto-merge` opts out of merging. Inline work commits
locally without push, PR, or CI. Main is the parent orchestrator: specialists return bounded
evidence, while main evaluates findings, decides repairs, and owns retries, publication, and final
verification. Follow the shared [parent-owned repair workflow]({{MPX_SHARED_INSTRUCTIONS}}/REPAIR_ORCHESTRATION.md).
Use concise normal prose for progress updates and a professional final report.

Apply these delivery defaults without routine confirmation. Ask for unresolved prerequisites or
material ambiguity, not preferences already settled by the workflow.

Before any provider command, read [Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md), then load
`mpxconfig.json` and independently resolve `issues.provider` and `repository.provider`. Load the
corresponding native guides linked there: repository providers are GitHub, GitLab, or Gerrit; Issue
providers are GitHub or KanbanFlow. Use each selected provider's documented native commands; never
invent `mpx issue`, `mpx review`, or `mpx ci` facade actions. Preserve the native authentication
environment; status/login diagnostics may inspect the active account but must not switch it.

## 1. Resolve and isolate

Parse `the invocation input`:

- Issue reference: fetch title, body, labels, comments, state, and URL with the selected issues
  provider. Extract the goal, constraints, acceptance criteria, and blocking relationships.
- Inline text: parse comma-separated tasks or Markdown checklist items. It has no Issue writeback.
- No argument: ask what to execute.

Use the checkout where the user launched the workflow. Read repository instructions, branch,
status, and available Issue/task metadata to establish its identity without routine confirmation.
Preserve unrelated work; ask only if a concrete checkout mismatch or overlapping changes prevent
safe execution. Do not create, switch, or remove worktrees.

If an Issue has `HITL` or `design needed`, ask whether to abort, run HITL grilling, or complete
design first.

## 2. Analyze

Invoke `mpx-explorer` with the Issue/task, current checkout, and breadth `medium`. Stop when
relevant files, callers, existing tests, and project patterns are located; return bounded evidence
with file/line references. For provider Issues, pass that evidence and the verified Issue
identity/data to `mpx-issue-analyzer`:

> Issue: [provider, target, ID, title, body, labels, comments, acceptance criteria, linked Issues]
> Codebase: [current checkout and exploration evidence] Constraints: [scope, repository
> instructions, known blockers] Classify bug/task/feature; return an execution plan with files, TDD
> behaviors, acceptance-to-test mapping, risks, open questions, external-library uncertainty, and
> referenced design artifacts. Return only the agent contract.

Present the analyzer's acceptance-to-behavior mapping and ask for confirmation only when it appears
incomplete or materially ambiguous; otherwise continue under the invocation's end-to-end
authorization. Ask only unresolved material questions. If external library behavior is uncertain,
invoke `mpx-context7-docs-fetcher`; do not guess APIs.

### Design Mapping

When Issue body/comments link design HTML, `SUMMARY.md`, a brief, or mockups, read them before
planning. Mockups are inspiration, not source of truth: match layout; map color intent to existing
semantic/theme tokens; reuse existing components and variants; add a variant rather than inlining a
divergent control. Pass these constraints unchanged to execution and verification.

## 3. Discover checks

Resolve the bundled [check detector](detect-check-scripts.mjs) relative to this loaded skill. Store
its validated literal absolute path as `<detector>` and run from the current checkout:

```bash
node "<detector>" .
```

For `PM_UNKNOWN=true`, ask for the package manager and rerun `node "<detector>" . <chosen_pm>`. For
`NO_PROJECT=true` or no runnable commands, report the missing discovery result and ask for the
project's verification commands before continuing; do not treat absent checks as passing.

Preserve the exact key=value output: `CHECK_ALL`, `TYPECHECK`, `LINT`, `FORMAT`, `BUILD`, `TEST`,
`TEST_UNIT`, `TEST_E2E`, package-prefixed keys, and matching `_DIR` working directories when
emitted. Pass command strings byte-for-byte with their working directories to every agent that
verifies, resolves conflicts, or fixes CI. Test commands are first-class CI-parity checks: checks
run in CI must pass locally before push.

When verification needs a server, main follows [server discovery and lifecycle](DEV_SERVER.md)
and supplies the verified URL to check/browser agents. A user-provided URL is optional.

## 4. Execute with TDD

Map each acceptance criterion to the confirmed observable behaviors. Hand the bounded implementation
to named agent `mpx-tdd-executor` with the exact behaviors, acceptance criteria, relevant context,
Design Mapping constraints, and exact discovered commands. Have the executor read [tests](tests.md)
and [mocking](mocking.md) before designing tests. Require red → minimal green → refactor for each
behavior and only its executor contract in return. Route `Completed` to verification; route
`Partial` with completed evidence and remaining items to one bounded retry; route `Blocked` to the
user without continuing to review or publication. Never weaken a correct test. Correct a test only
when its assertion, selector, or setup is demonstrably wrong against the acceptance criteria;
require the executor to return the reason and carry it into the commit message.

## 5. Verify and review

Follow [Parent-owned Check and CI Repair]({{MPX_SHARED_INSTRUCTIONS}}/REPAIR_ORCHESTRATION.md). Dispatch `mpx-checker`
with the exact static and test command arrays. In parallel where supported, dispatch the default
reviewers `mpx-reviewer-code-quality`, `mpx-reviewer-best-practices`, `mpx-reviewer-spec-alignment`,
and `mpx-reviewer-test-quality`; add `mpx-reviewer-security`, `mpx-reviewer-performance`, and
`mpx-reviewer-error-handling` for `--full-review`. Give each specialist the context, acceptance
criteria, Design Mapping constraints, branch, and changed files. Use `mpx-chrome-devtools-tester` only where UI interaction lacks e2e coverage. For authenticated
browser verification, it may read explicitly approved project test-auth context according to
repository instructions; this is distinct from provider credential routing. Never expose or commit
the values, and never repurpose provider credentials.

Supply all bounded checker, reviewer, and browser results to `mpx-check-reporter`. Evaluate its
assessment and send only accepted, precise repairs to `mpx-executor` or behavior repairs to
`mpx-tdd-executor`. Recheck after repairs. Route remaining unresolved findings to triage; on a
blocker, do not push. Main owns a maximum of three repair/review iterations and a fresh complete
local verification before publication.

## 6. Unresolved triage

If no unresolved items remain, skip this phase. For a provider Issue, send unresolved findings,
unanswered questions, and discovered out-of-scope edge cases to `mpx-unresolved-issue-tracker`,
preserving exact content and linking source/child Issues through body links. It searches the parent
and siblings, appends where scope matches, and otherwise creates/updates the provider-native
unresolved tracking Issue with `HITL`. Inline work reports unresolved items locally.

## 7. Commit and push

Invoke `mpx-git-committer`:

> push: true for provider Issues; false for inline work issue_ref: verified
> provider/target-appropriate closing/reference syntax, absent for inline work commit_hint:
> [implemented behaviors and any test-correction reasons for the commit message] Return only the
> agent contract.

Route `OK`; for `SKIP`, verify whether push remains; for `FAIL`, give the concrete failure to a
bounded executor and retry at most twice. No secret, generated artifact, or unrelated file may be
staged.

## 8. Publish and close out

Inline work skips provider PR and CI: report implemented behaviors, tests added/modified and their
results, changed files, local commit, review summary, unresolved items, and blockers. State that
push and provider close-out were skipped.

Otherwise invoke `mpx-review-manager` with the validated repository target, source branch, selected
Issue provider, target, ID and canonical reference, base branch, and implementation summary. It uses
the consolidated repository-provider guide to find or create/update exactly one PR with parent/child
body links and provider closing syntax. Route `selection_required` to the user to select the
returned existing PR ID/URL, then reinvoke with that explicit immutable ID. Route `OK` only when an
explicit PR ID/URL is returned; route `FAIL` to a bounded fix/retry (maximum two), then stop. Before
retrying an uncertain create, resolve whether it succeeded; never duplicate a PR. Retain that
identity and never replace it by discovery. Then read and follow [CLOSE_OUT.md](CLOSE_OUT.md).

## Flags

- `--full-review`: seven-reviewer set.
- `--no-auto-merge`: stop after green CI and final-report comment, leaving the PR open.

## Invariants

TDD is mandatory; one focused behavior per test; red before green; minimal green; fix causes rather
than suppressing diagnostics. Commit after the selected Issue. CI is the completion gate. Default
after green is provider-policy-compliant merge; checkout handling follows [CLOSE_OUT.md](CLOSE_OUT.md). Main never
requests or exposes raw reviewer findings, test output, or CI logs when a bounded agent contract
exists.
