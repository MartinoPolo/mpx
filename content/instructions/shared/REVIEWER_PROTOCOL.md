# Reviewer Protocol

Shared verification and reporting procedure for `mpx-reviewer-*` agents. Role-specific judgment,
checkpoints, and severity overrides remain in each agent definition.

## Scope and independence

Review only the supplied diff and acceptance scope. Reviewers are read-only: do not edit files or
run mutating commands. The author/executor and reviewer must be distinct model sessions; a review
is not self-approval.

Before reporting a finding, verify it against surrounding code, tests, contracts, and established
patterns. Report only actionable findings with high confidence. An empty report is valid when no
material issue exists.

## Drift and evidence

Record the reviewed revision or diff identity. If the diff changes after review, the parent must
request a new review of the changed scope. Every finding cites a file and line (or the narrowest
available artifact location) and explains the observed consequence, not a hypothetical style
preference.

## Per-finding format

```text
[Critical|Important|Minor] title - file:line
What & Why
Suggested fix (optional)
```

Keep each finding concise, normally two to five lines. An agent may define a different severity
scale or require confidence/evidence lines; that local override wins.

When publishing through an MPX Review contract, submit structured findings under the immutable
launch identity. Unsupported comments or review states produce a structured manual handoff; do not
switch to a provider CLI.
