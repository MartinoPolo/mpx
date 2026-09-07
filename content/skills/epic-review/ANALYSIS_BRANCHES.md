# Epic Review Specialized Analysis Branches

Run all four concurrently with the six named reviewer agents. Every branch returns each requested field or an explicit
no-findings result. Prompts include bounded authorized context and selected provider facts; agents do not discover or
change providers.

## 7. Architecture

Dispatch named canonical agent `mpx-scanner-architecture` using its declared `standard` scanner model class:

> Scan files changed during Epic <ID>: "<title>" for structural concerns introduced or worsened across the complete
> Epic: coupling, shallow modules, misplaced policy, unstable interfaces, and decomposition candidates.
>
> Changed files with stats: <list> Confirmed architectural decisions: <filtered discussion>

It uses its own deep-module and interface-design references. Require severity, title, `file:line`, consequence,
evidence, and suggested action.

## 8. Cleanup

Dispatch named canonical agent `mpx-explorer` (declared `exploration` policy), medium breadth, stopping after changed
files and one repository-wide usage search per candidate:

> Scan Epic changed files/diff for unused exports/types/functions, stale imports, cross-PR duplication, superseded
> helpers, and orphaned test fixtures. Verify every usage before reporting. HIGH-confidence findings only.

Require:

```text
[Critical|Important|Minor] title — file:line
Consequence: ...
Evidence: ...
Suggested action: ...
```

## 9. Documentation

Dispatch `mpx-explorer`, medium breadth, stopping after existing `.mpx/CONTEXT.md`, `.mpx/DECISIONS.md`, and `README.md`
are compared with confirmed Epic behavior. Missing files are out of scope.

Check domain terms/core-feature status, decision drift, and setup/feature/usage instructions. Require severity, title,
file, exact drift, evidence, and specific update.

## 10. Unresolved work

Dispatch a generic analysis agent by resolving the canonical `standard` class through the existing active runtime
profile and passing that concrete structured model selection; do not add model-resolution machinery. Supply authorized
Issue and PR bodies/comments, changed files, selected `issues.provider`, and native read commands from its shared
provider guide.

Search for deferred, TODO, later, unresolved, out of scope, follow-up, future work, skipped, punted, known issue, hack,
workaround, temporary, and equivalent language. For each candidate:

1. inspect relevant source to determine whether a later change completed it;
2. search open Issues through the selected Issue provider's native command;
3. classify `Complete`, `Already Tracked (<ID/link>)`, `Needs AFK Issue`, or `Needs HITL Issue`;
4. omit Complete from findings but retain verification evidence.

Require:

```text
[Critical|Important|Minor] title
Source: PR or Issue <ID>, body or comment (author only when necessary)
Status: Complete|Already Tracked|Needs AFK Issue|Needs HITL Issue
Consequence: ...
Evidence: ...
Suggested action: ...
Open decisions: ... (HITL only)
```

Do not reproduce unrelated private conversation. If Issue search is unsupported, classify tracking status as unavailable
rather than guessing and return a manual search handoff.
