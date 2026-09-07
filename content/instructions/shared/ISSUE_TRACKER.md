# Issue, PR, and CI Interfaces

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable. Canonical workflows have two
approved interfaces. The calling workflow selects one explicitly:

1. the typed provider-neutral `mpx issue`, `mpx review`, and `mpx ci` APIs; or
2. a native provider guide governed by [PROVIDER_ROUTING.md](PROVIDER_ROUTING.md).

Native workflows use their guide directly and do not require a typed facade. Never use an unselected provider CLI as
fallback.

## Typed MPX interface

Pass `--identity <launch-identity>` and `--json` on every operation. Reuse the immutable launch identity; never infer an
account. Read exact actions and flags from generated [basic](MPX_CLI_BASIC.md) or [complete](MPX_CLI_REFERENCE.md) help.
Use returned structured IDs for later operations, preserve schema/version fields, and fail closed on unknown versions.
Do not invent an action absent from installed help.

The typed interface remains valid when its stable structured envelope is required and for managed Local Markdown
storage. Local always uses the existing managed MPX installation.

## Native interface

Read the nearest project configuration, select only the needed role, validate an explicit target, and load the matching
[GitHub](providers/GITHUB.md), [GitLab](providers/GITLAB.md), [KanbanFlow](providers/KANBANFLOW.md),
[Gerrit](providers/GERRIT.md), or [Local](providers/LOCAL.md) guide. Issue work uses only the Issue provider; PR and
CI use only the repository provider. Native authentication remains unchanged.

Guides define supported list/view/create/edit/comment/label, milestone, PR, merge, and CI operations. Their
limitations are contractual. Use body links rather than native sub-Issue hierarchy.

## Unsupported operations

Stop only the affected branch and return a manual handoff containing:

- selected interface, role/provider, and explicit target ID;
- immutable launch identity as an opaque label only when the typed interface or launch binding supplied one;
- requested operation and exact unsupported/configuration/tooling condition;
- safe remaining steps and the decision needed.

Never switch providers, copy tokens, silently omit fields, reinterpret an unsupported operation, or repeat an uncertain
mutation.

## Labels and milestones

Inspect existing labels and milestones first. Typed operations use only documented semantic requests. Native operations
use exact provider values. Create a label or milestone only when supported and explicitly authorized. A missing or
rejected required value is a decision point, not permission to continue silently.
