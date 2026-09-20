---
name: execute
description:
  Execute one Issue or inline work with implementation, testing, review, and verified delivery
argument-hint: '[issue|inline/checklist] [--no-tdd|--full-review|--no-auto-merge]'
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

Main owns issue/specification analysis, evaluates results, approves repairs, and consolidates
decisions. After analysis, delegate implementation, checks, reviews, simplification, publication,
and CI monitoring. Invocation authorizes delivery: work repositories stop at green CI with an
unmerged PR/MR; personal repositories require confirmed merge plus safe base update.
`--no-auto-merge` stops at green CI with the PR/MR open. Inline work commits locally without push,
PR, or CI. Establish personal/work ownership from the resolved account/domain context; ask if it
is unavailable or contradictory. Do not infer ownership from the Git host.

Keep the issue identity, agreed acceptance criteria, and selected delivery endpoint as the execution objective. Recheck them before accepting implementation, before publication, and in the final report. Completion requires evidence that the acceptance criteria and delivery endpoint are satisfied;

Apply these delivery defaults without routine confirmation. Ask for unresolved prerequisites or
material ambiguity, not preferences already settled by the workflow.

Before any provider command, read [Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md), then load
`mpxconfig.json` and independently resolve `issues.provider` and `repository.provider`. Load the
corresponding native guides linked there: repository providers are GitHub, GitLab, or Gerrit; Issue
providers are GitHub or KanbanFlow. Use each selected provider's documented native commands; never
invent `mpx issue`, `mpx review`, or `mpx ci` facade actions. Preserve the native authentication
environment; status/login diagnostics may inspect the active account but must not switch it.

## 1. Resolve

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

Read the actual requirements, comments, and constraints yourself. Invoke `mpx-explorer` for broad
discovery with the Issue/task, current checkout, and breadth `medium`. Stop when relevant files,
callers, existing tests, and project patterns are located; return bounded evidence with file/line
references. Main synthesizes the implementation scope, observable acceptance criteria, risks, and
verification plan. Ask only unresolved material
questions. If external library behavior is uncertain, invoke `mpx-context7-docs-fetcher`; do not
guess APIs.

### Design Mapping

When Issue body/comments link design HTML, `SUMMARY.md`, a brief, or mockups, read them before
planning. Mockups are inspiration, not source of truth: match layout; map color intent to existing
semantic/theme tokens; reuse existing components and variants; add a variant rather than inlining a
divergent control. Pass these constraints unchanged to execution and verification.

## 3. Discover checks

Use explicit project `fast_checks` / `full_checks` configuration first, the bundled
[check detector]({{MPX_SHARED_INSTRUCTIONS}}/detect-check-scripts.mjs) second, and checker
investigation of unresolved discovery last. Resolve the detector relative to this loaded skill and
run `node "<absolute-detector>" "<checkout>"`. Retain its ordered JSON `fast_checks`, `full_checks`,
and `unresolved` result. Pass exact command strings and working directories unchanged; resolve
relative `cwd` values against the checkout, not the skill folder. If configuration comes from the
main checkout or a machine-local override, supply its resolved config object in a temporary JSON
file as the detector's third argument, after the checkout and package manager (empty to discover).
Do not write temporary discovery configuration into the repository.

Fast defaults are formatting, typechecking, unit tests, Oxlint, and project-configured Fallow.
Deferred/full checks are ESLint, build, E2E, and opaque combined checks. These are scheduling
categories, not measured duration guarantees. Fallow stays project-owned; do not install or enable
it globally. Missing or unresolved verification is not a passing result; ask only when checker
investigation cannot establish the required commands.

When verification needs a server, main follows [server discovery and lifecycle](DEV_SERVER.md)
and supplies the verified URL to check/browser agents. A user-provided URL is optional.

## 4. Implement and simplify

Dispatch one bounded `mpx-executor` with the agreed requirements, acceptance criteria, scope,
relevant file pointers, Design Mapping constraints, exact focused check commands, and selected test
mode. Pass that test mode to every fresh executor, including each implementation or CI repair.
The executor chooses implementation/test details within that scope or follows concrete edit
instructions when supplied. Default to meaningful test-first implementation. `--no-tdd` excludes
creating tests during implementation, not running existing tests during verification. Necessary
updates or retirement of obsolete existing tests follow the new acceptance criteria and must be
reported. Do not invent tests merely to satisfy TDD.

Evaluate the executor's actual diff and verification evidence. Material ambiguity returns to main.
Dispatch `mpx-simplifier` for one justified behavior-preserving pass within scope before final
review; leaving good code unchanged is success. Give it the same requirements, constraints, and
selected test mode; under `--no-tdd` it must not create or invent tests.
Consolidate material independent choices, reasons, and uncertainty or alternatives worth human
review for the final report. Routine coding choices need no entry; create no report files.

## 5. Verify and review

Pass the resolved absolute detector path and exact check arrays with working directories to
`mpx-checker`. Run formatting and early checks before parallel review. Formatting writes
are allowed and preferred; include resulting changes in verification and review. Then dispatch
deferred checks and independent reviewers against stable source. Do not run simultaneous writers
or parallel checks sharing mutable fixtures or servers.

Default reviewers are `mpx-reviewer-code-quality`, `mpx-reviewer-best-practices`,
`mpx-reviewer-spec-alignment`, and `mpx-reviewer-test-quality`; add `mpx-reviewer-security`,
`mpx-reviewer-performance`, and `mpx-reviewer-error-handling` for `--full-review`. Give each the
context, acceptance criteria, Design Mapping constraints, branch, and changed files. Prefer
Playwright for meaningful browser verification. Use `mpx-chrome-devtools-tester` where UI
interaction lacks adequate E2E coverage. For authenticated browser verification, it may read
explicitly approved project test-auth context according to repository instructions; this is
distinct from provider credential routing. Never expose or commit the values, and never repurpose
provider credentials.

Evaluate supplied findings and contradictory advice before accepting repairs. Use a fresh executor
for each repair, never a resumed one. Include the selected test mode, relevant requirements,
failures, acceptance criteria, precise repair objective, and file pointers. Instruct it to inspect
current `git diff` and relevant files itself; do not paste large diffs/source into the prompt.
Recheck and review changed code.
Main owns a maximum of three local repair/review iterations and a fresh complete local verification
before publication. A blocker or exhausted budget stops publication.

## 6. Unresolved triage

If no unresolved items remain, skip this phase. For a provider Issue, send unresolved findings,
unanswered questions, and discovered out-of-scope edge cases to `mpx-unresolved-issue-tracker`,
preserving exact content and linking source/child Issues through body links. It searches the parent
and siblings, appends where scope matches, and otherwise creates/updates the provider-native
unresolved tracking Issue with `HITL`. Inline work reports unresolved items locally.

## 7. Deliver and report

Prepare the substantive change summary before delivery so commit/PR wording uses the best
synthesis. Recheck the execution objective and final verified state, then invoke `mpx-shipper`
with explicit intended paths, summary, exact verification evidence, and the selected endpoint.
Inline work always uses `commit` and requires no provider configuration, remote, repository target,
or Issue identity. Only provider Issue work uses `pr` for work repositories or `--no-auto-merge`;
otherwise personal provider Issue work uses `merge`. For provider Issue delivery, supply the
configured remote and validated repository target, independently verified Issue identity and
canonical link, source and actual target branches, existing immutable PR/run identities, merge
authorization, and repository merge policy. For personal base synchronization, identify an
existing target-branch checkout and confirm it is idle; require clean index/worktree, correct
upstream, no in-progress Git operation, and fast-forward only. Git status alone does not prove
availability. Do not switch, create, or remove checkouts. Report confirmed merge and blocked base
synchronization separately; do not claim the full personal endpoint when synchronization is blocked. Three shipping attempts total: initial attempt plus two repair/retry attempts. Do not
reset this budget between stages or via goal continuation. Main evaluates shipping failures,
delegates accepted repairs to a fresh executor, verifies again, and invokes the
shipper with completed-stage evidence so it does not repeat completed operations.
For CI repairs, supply the validated repository, PR, branch, commit, and failing run/job identities.

The final user report comes after delivery and includes actual acceptance and delivery evidence,
verification results, material choices and uncertainty, unresolved issues, and any blocked merge
or base synchronization. Durable decisions go into DECISIONS only after confirmation.

## Flags

- `--no-tdd`: do not create tests during implementation; existing checks still run.
- `--full-review`: seven-reviewer set.
- `--no-auto-merge`: stop after green CI, leaving the PR/MR open.
