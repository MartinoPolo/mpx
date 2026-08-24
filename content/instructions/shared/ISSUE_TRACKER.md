# Issue Tracker Capabilities

Skills use provider-neutral MPX capabilities. They do not detect a hosting provider or invoke a
provider CLI directly. The immutable launch identity selects the configured adapter.

## Required identity

Pass `--identity <launch-identity>` and `--json` on every operation. Use the immutable identity
selected when MPX launched. If the launch identity is unavailable, stop and ask the user rather
than inferring an account or repository from local remotes.

## Capabilities

| Intent | Provider-neutral capability |
| --- | --- |
| Create a tracked work item | `mpx issue create --identity <launch-identity> --json` with title, body, and semantic labels |
| Read a tracked work item | `mpx issue view --identity <launch-identity> --json` with an explicit issue ID |
| Update or comment on work | `mpx issue update --identity <launch-identity> --json` with an explicit issue ID and requested changes |
| Open a code review | `mpx review create --identity <launch-identity> --json` with title, body, source branch, and target branch |
| Read or update a review | `mpx review view --identity <launch-identity> --json` or `mpx review update --identity <launch-identity> --json`, each with an explicit review ID |
| Inspect pipeline status | `mpx ci status --identity <launch-identity> --json` with an explicit review or pipeline ID |

Use the structured response to capture returned IDs. There is no implicit issue, review, or CI
discovery. If a capability reports that an operation or field is unsupported by the configured
adapter, report that limitation and ask the user how to proceed.

## Semantic labels

Treat labels as semantic requests such as `bug`, `refactor`, `task`, `Design needed`, `HITL`, or
`AFK`. Submit them through the issue capability and let the configured adapter map or reject them.
Do not create, reinterpret, or silently omit an unsupported label. Report the structured error and
ask the user whether to continue without it.
