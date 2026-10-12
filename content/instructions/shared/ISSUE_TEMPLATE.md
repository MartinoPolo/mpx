# Issue Template

The body of every task Issue. Keep only the sections that apply; no other headings.

```markdown
> **Unanswered questions:**
>
> - [A decision only a human can make]

## Description

[What is wrong or wanted, and why, in one to five sentences. Where it happens: module, symbol, or
affected page, with repo-relative paths as hints.]

## Investigation

[Repro steps or the failing command. Expected and actual behavior with evidence. The cause, labelled
as a hypothesis until confirmed.]

## Acceptance Criteria

- [ ] [Observable condition]
- Out of scope: [what to leave alone]

## Epic

- Parent: [Epic title and canonical URL or immutable ID]

## Blocking Relationships

- Blocked by [Issue title and canonical URL or immutable ID] (reason)
- Blocks [Issue title and canonical URL or immutable ID] (reason)
```

## Rules

- Title: one line naming the area and the symptom or outcome, without an Epic number or a
  conventional-commit prefix.
- Describe the outcome; the executor chooses the implementation. No user stories, requirement IDs,
  implementation plans, or content repeated across sections.
- Put each link and screenshot in the section it supports.
- Paths are repo-relative hints, never absolute. The code is the source of truth.
- `## Epic` and `## Blocking Relationships` hold body links for real relationships only; they do not
  create provider-native hierarchy.
- HITL means an unresolved human decision, recorded in the blockquote. Manual testing, visual
  inspection, review, and QA are not HITL.
- When the user answers a question, delete it from the blockquote and put the answer where it
  belongs in the body. Remove the blockquote when no question remains.
