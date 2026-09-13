# Parent-owned Check and CI Repair

Canonical workflow for local check/review findings and provider CI failures. The invoking skill is
the parent: specialists collect or analyze evidence, while the parent evaluates findings, authorizes
repairs, controls bounded retries, and confirms final status independently.

## Local checks and review

1. The parent dispatches `mpx-checker` with the exact commands and working directories discovered
   for the repository. It also dispatches the reviewers selected by the invoking skill, with the
   changed files, acceptance criteria, and relevant constraints. The checker and reviewers return
   their bounded contracts; they do not repair findings.
2. The parent supplies those complete contracts to `mpx-check-reporter`. Require an assessment
   containing evidence, file/line locations, suggested repairs, blockers, uncertainty, and relevant
   verification commands. The reporter analyzes only supplied results: it does not run checks, edit
   files, delegate, or decide whether a finding is accepted.
3. The parent evaluates every reported finding against the task and repository evidence. It records
   accepted, rejected, duplicate, out-of-scope, and unresolved findings without hiding load-bearing
   evidence.
4. For accepted repairs, the parent sends one bounded, precise work item at a time to
   `mpx-executor`, or to `mpx-tdd-executor` when observable behavior requires red/green iteration.
   Include exact files, required behavior, acceptance criteria, and verification commands. Neither
   reporter nor reviewer authorizes broader work.
5. Re-dispatch the checker and affected reviewers after repairs, then evaluate a fresh reporter
   assessment. The parent owns the invoking skill's retry budget. Exhaustion or a blocker stops
   publication and is reported to the user.
6. Before publication, the parent runs or dispatches the exact complete local verification plan once
   more and confirms its fresh result. Earlier reports and repair-command success are not a final
   gate.

## CI analysis and repair

1. The parent validates the configured repository provider and immutable repository, PR, branch, and
   native run/job identity. Ambiguous or missing identity blocks analysis. Provider capability gaps
   use the selected native guide's structured manual handoff; never switch providers or
   authentication routes.
2. Dispatch `mpx-ci-analyzer` with those identities, the selected provider guide, and exact local
   verification commands. It reads only the identity-bound provider logs and returns bounded failure
   evidence, locations when available, root- cause assessment, suggested repairs, blockers,
   uncertainty, and verification commands. It does not edit, delegate, rerun jobs, commit, push, or
   watch subsequent CI.
3. The parent evaluates the analysis. Send accepted, bounded repairs to `mpx-executor` or
   `mpx-tdd-executor`, run the exact local verification, commit and push only through the authorized
   parent workflow, then request a new CI run or wait for the provider-triggered run.
4. The parent owns bounded retry decisions. After each attempt it validates the new run identity and
   may dispatch a fresh analyzer. Exhaustion, unsupported operations, or uncertainty that prevents a
   safe repair stops publication.
5. Independently query fresh native status for the immutable PR and latest validated run before
   declaring CI green or merging. Analyzer output and an earlier green run are not final
   confirmation.
