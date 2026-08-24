---
name: vocabulary
description: "Creates or updates the domain language section of CONTEXT.md, confirming terms with the user first."
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: name-only
---
# Vocabulary

### Process

**Step 1: Gather terms**

- Scan the current conversation for domain-relevant nouns, verbs, and concepts
- If the invocation input specifies a topic, focus extraction on that area
- Read `.mpx/CONTEXT.md` § Domain Language. If CONTEXT.md doesn't exist, report error and stop.
- Also sca<configured-path>epic issues, README, key source files for domain terms

**Step 2: Identify problems**

- Flag ambiguities (same word used for different things)
- Flag synonyms (different words for the same concept)
- Flag vague terms (imprecise language that could cause confusion)

**Step 3: Propose vocabulary**

- Be opinionated — when multiple words exist for the same concept, pick ONE canonical term
- For each ter<configured-path>canonical name, one-sentence definition
- Group terms into natural clusters (by subdomain, lifecycle, or actor)
- Show relationships between terms with cardinality (e.g., "A **User** has many **Sessions**")

**Step 4: Confirm with user**

Present each candidate term with its full proposed entry text (`**Term** — One-sentence definition.`):

- New terms — show the exact text that would be written
- Updated definitions — show old → new
- Flagged ambiguities or conflicts
- Ask user to approve, edit, or reject each term

Only write confirmed terms.

**Step 5: Write**

Update `.mpx/CONTEXT.md` `## Domain Language` section using definition-list forma<configured-path>markdown
## Domain Language

**Workspace** — Top-level containe<configured-path>one GitHub repo + one project folder + one window.
**Issue** — Atomic work unit. One GitHub issue, one worktree, one branch, one color.

_Avoid_: "task" for Issue, "project" for Workspace.

## Relationships

- A **Workspace** has many **Issues** (1:N)
- An **Issue** has many **Sessions** (1:N)

## Flagged Ambiguities

- "workspace" was previously used for both the app container and VS Code workspace — resolve<configured-path>**Workspace** is the Grovekeeper container only.
```

If updatin<configured-path>merge new terms into existing structure, update changed definitions, preserve terms that haven't changed.

**Step 6: Summary**

- Output inlin<configured-path>number of terms added, updated, and unchanged
- List any unresolved ambiguities for future discussion

### Rules

- Only include domain terms — skip generic programming concepts (function, class, API, database)
- Keep definitions to ONE sentence maximum
- Flag conflicts explicitly — never silently resolve ambiguity
- Show relationships with bold term names and cardinality
- When re-runnin<configured-path>read existing file, incorporate new terms, update definitions, re-flag ambiguities
