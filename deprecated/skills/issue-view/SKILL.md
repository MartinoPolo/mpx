---
name: issue-view
description: Retrieve and summarize one Issue through the configured MPX provider
triggers: viewing or understanding an Issue
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: full
---

# View an Issue

Retrieve one Issue identified by the invocation input and present its current provider-neutral state.

## Provider routing

Read the nearest committed `mpxconfig.json`, resolve `issues.provider`, and follow
[provider routing](../shared/PROVIDER_ROUTING.md). Load only the selected [GitHub](../shared/providers/GITHUB.md),
[GitLab](../shared/providers/GITLAB.md), [KanbanFlow](../shared/providers/KANBANFLOW.md), or
[Local Markdown](../shared/providers/LOCAL.md) guide. Preserve launch-bound authentication and explicit repository,
board, project, and Issue identity. Never infer the provider from remotes, switch providers, or invent commands. Local
Markdown uses only its documented MPX Issue interface. Resolve canonical tool paths through
[content paths](../shared/CONTENT_PATHS.md).

## Workflow

1. Resolve the intended Issue identifier from explicit invocation input or unambiguous conversation context. Ask when no
   identifier is available or multiple identifiers are plausible.
2. Verify the selected Issue provider and target, then run only that guide's documented view operation. Use an explicit
   Issue identifier and repository/project/board target when context is ambiguous.
3. Preserve the immutable identifier and canonical URL returned by the provider. Summarize title, state, description,
   requirements, acceptance criteria, labels, assignees, milestone, relationships, and recent discussion only when those
   fields are available.
4. Distinguish a field absent from the provider response from a field that is present but empty. Preserve canonical
   links and body-link relationships exactly enough to remain actionable.
5. Clearly separate provider facts from any concise interpretation. Do not infer updates, hierarchy, blockers,
   completion, or synchronization that are not in the response. Body links are documentary and do not imply native
   hierarchy.

## Errors and capability gaps

If configuration, launch identity, authentication, target, capability, or output is ambiguous, fail closed and report
the exact missing condition. For a structured provider error, report its code and actionable message and stop. Never
fall back to a different provider or direct storage access.

## Output

Report the immutable Issue ID and canonical URL first, followed by the available current state and a concise summary.
Explicitly state important unavailable fields or an unverified result rather than presenting assumptions as facts.
