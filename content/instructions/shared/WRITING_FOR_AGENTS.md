# Writing for Agents

- Describe purpose and distinct invocation triggers concisely in portable metadata; omit synonyms
  and implementation summaries.
- Put common actions first. Keep each concept’s conditions and caveats together; defer branch-only
  detail through precise references. Split for workflow or context boundaries, not line counts.
- Give each action its scope and observable result, integrating necessary validation and stopping
  conditions. Use separate gates only for approval, irreversible actions, false-success risks,
  partial-success boundaries, or exhaustive reconciliation.
- State the desired behavior. Retain negative instructions when they protect an important boundary.
- Make essential instructions available when needed. Small duplication is acceptable when it
  avoids fragile dependencies or unnecessary loading.
- Remove stale, discoverable, and behaviorally redundant prose. Preserve uncertain cases for
  behavioral evaluation rather than automatic deletion. Verify referenced files and compiled
  dependencies.
