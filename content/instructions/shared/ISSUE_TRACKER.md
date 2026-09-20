# Issue, PR, and CI Interfaces

Here, PR means a GitHub pull request, GitLab merge request, or Gerrit change, as applicable.
Provider operations use [Provider Routing](PROVIDER_ROUTING.md) and the selected native guide. MPX
does not provide `mpx issue`, `mpx review`, or `mpx ci` facade commands.

## Provider interface

Read the nearest project configuration, select only the needed role, validate an explicit target,
and load the matching guide. Repository operations support [GitHub](providers/GITHUB.md),
[GitLab](providers/GITLAB.md), or [Gerrit](providers/GERRIT.md). Issue operations support
[GitHub](providers/GITHUB.md) or [KanbanFlow](providers/KANBANFLOW.md). The roles are independent.
[Local](providers/LOCAL.md) is explicitly unsupported; never reinterpret it as GitHub. Native
authentication remains unchanged.

Guides define their supported list, view, create, edit, comment, label, milestone, PR, merge, and CI
operations. Their limitations are contractual. Use body links rather than native sub-Issue
hierarchy.

## Unsupported operations

Stop only the affected branch and return a manual handoff containing:

- selected role, provider, and explicit target ID;
- requested operation and exact unsupported, configuration, or tooling condition;
- safe remaining steps and the decision needed.

Never switch providers, copy tokens, silently omit fields, reinterpret an unsupported operation, or
repeat an uncertain mutation.

## Labels and milestones

Inspect existing labels and milestones first. Use exact native provider values. Create a label or
milestone only when supported and explicitly authorized. A missing or rejected required value is a
decision point, not permission to continue silently.
