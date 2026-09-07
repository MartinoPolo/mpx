---
name: agent-create
description: 'Creates or restructures a portable custom agent when a user needs a delegated role, distinct...'
argument-hint: '[agent name or description]'
triggers: create custom agent; restructure agent; design delegated role or agent workflow
metadata:
  author: MartinoPolo
  version: '0.7'
  category: utility
  mpx:
    schemaVersion: 1
    contentVersion: 1
    skillPacks: [work]
    defaultExposure: explicit-only
    capabilities: [delegate, read, search, write]
---

# Agent Create

Create a focused custom agent following the target repository's canonical conventions. Use `the invocation input` for
known requirements.

Before starting, read [Authoring Conventions](../shared/AUTHORING.md),
[Writing for Agents](../shared/WRITING_FOR_AGENTS.md), and [Sub-Agent Protocol](../shared/SUBAGENT_PROTOCOL.md)
completely. They are the authoritative sources for writing, identity, tools, model classes, lifecycle, and permissions.

Resolve assets relative to this loaded skill; follow [Content Paths](../shared/CONTENT_PATHS.md) when a tool requires an
absolute path.

## Workflow

1. **Fetch current mechanics.** For runtime or library documentation available through Context7, spawn the existing
   `mpx-context7-docs-fetcher` and ask for the active runtime's current custom-agent frontmatter, packaging, delegation,
   tool, model, permission, and reload mechanics with runtime-source citations. For installed-runtime mechanics that
   Context7 does not cover, return a bounded handoff asking the parent to read the installed runtime documentation and
   provide the cited findings. Treat only cited runtime facts as platform mechanics, and keep general writing guidance
   in the shared references rather than copying it into the draft.

2. **Gather requirements.** In one numbered request, ask for every item not already answered by `the invocation input`:
   1. purpose and agent name;
   2. distinct delegation branches and the phrases that route to each;
   3. inputs and outputs for every branch;
   4. ordered actions and each branch's expected result;
   5. points where premature or false completion is plausible;
   6. reference needs and branch-only facts;
   7. read-only or read-write scope;
   8. required capabilities/tools;
   9. mechanical, exploration, standard, advanced, or frontier model class and required effort;
   10. color when supported by the target profile;
   11. parent-facing output shape.

   Require every field to be answered or marked not applicable. Clarify contradictions before drafting.

3. **Design the hierarchy.** Assign every requirement exactly one authoritative location. Keep universal ordered actions
   in the workflow, co-locate each branch's rules, and disclose branch-only references through precise one-level
   pointers. Keep one responsibility and a body near 100 lines. Split only when a real branch or sequence boundary
   justifies the context hop.

4. **Draft the agent.** Determine the target repository's configured canonical agent root from manifests and existing
   artifacts; in this repository it is `content/agents/`. Draft `<agent-root>/<agent-name>.md` using lowercase
   hyphenated identity, except for an exact documented built-in override. Use:
   - a one-line description under 250 characters that front-loads every distinct delegation branch;
   - canonical capability classes rather than vendor tool names;
   - a structured model class and effort policy, translated by runtime profiles to concrete model IDs;
   - color only where canonical schema supports it or in the runtime projection that owns it;
   - a focused role, numbered workflow, stop conditions, and parseable output contract.

   Follow Sub-Agent Protocol for MCP, overrides, model parameters, nesting, and grants. Align filename and identity.
   Grant every used capability and no unused capability. Account for all requested branches in behavior and output.
   Write imperative steps with semantic endpoints; integrate relevant validation and stop conditions into those actions.
   Add a standalone gate only for an ambiguous or risky transition allowed by shared policy.

5. **Validate and prune.** Compare the draft against the fetched mechanics and all three shared references. Check every
   gathered requirement, filename/identity alignment, branch coverage, capability use, model configuration, output
   parseability, and reference resolution. Apply the single-source, environment-cache, relevance, positive-target,
   no-op, hierarchy, and semantic-completion tests. Keep uncertain no-ops as manual behavioral findings; record unmet
   applicable rules with exact reasons. Reread the complete edited artifact.

6. **Review with the user.** Present the full file or a precise path plus complete diff, delegation branches, hierarchy,
   runtime-profile model/tool translation, guideline-driven edits, validation results, and unresolved findings. Apply
   requested revisions and repeat validation until the user approves and every finding is resolved or explicitly
   accepted.

## Final report

```markdown
Created/Changed: [path] Branches: [branch -> trigger -> expected result] Model Policy: [class/effort -> runtime-profile
translation] Capabilities: [canonical grants -> runtime tool translation] Validation: [check results] Manual No-op
Tests: [none or findings] Requirement Accounting: [each gathered requirement -> owning location] Artifacts: [every
changed path] Approval: [approved or pending]
```
