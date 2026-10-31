# Issue Template

The body of every task Issue. Keep only the sections that apply; no other headings.

```markdown
[What is wrong or wanted, and why, in one to five sentences. Where it happens: module, symbol, or
affected page, with repo-relative paths as hints. Where to see it: URL or story, and the screenshot
that shows it.]

### Acceptance criteria

- [Observable condition]
- Out of scope: [what to leave alone]

### Epic

- Parent: [Epic title and canonical URL or immutable ID]

### Blocking relationships

- Blocked by [Issue title and canonical URL or immutable ID] (reason)
- Blocks [Issue title and canonical URL or immutable ID] (reason)

### HITL (unanswered questions)

- [A decision only a human can make]. Recommendation: [answer]
```

## Rules

- Title: one line naming the area and the symptom or outcome, without an Epic number or a
  conventional-commit prefix.
- No heading above the description. Plain bullets; KanbanFlow does not render `[ ]` checkboxes.
- Describe the outcome; the executor explores the code and chooses the implementation. No user
  stories, requirement IDs, implementation plans, or content repeated across sections.
- Findings worth keeping, such as reproduction details, a cause hypothesis, or entry points, go into
  Issue comments as short pointers, one topic per comment. Never put probe results or session
  history in the body.
- Put each link and screenshot in the section or comment it supports, attached through the provider
  guide. GitHub embeds images inline; where the provider cannot embed them (KanbanFlow), name each
  attached image in the text.
- Paths are repo-relative hints, never absolute. The code is the source of truth.
- `### Epic` and `### Blocking relationships` hold body links for real relationships only; they do
  not create provider-native hierarchy.
- HITL means an unresolved human decision, recorded in the HITL section. Manual testing, visual
  inspection, review, and QA are not HITL.
- When the user answers a question, delete it from the HITL section and put the answer where it
  belongs in the body. Remove the section when no question remains.

## Labels and assignee

Every Issue receives:

- One type, unless the creating skill fixes it: `bug` (`Something isn't working`, `D73A4A`) for a
  defect, `enhancement` (`New feature or request`, `A2EEEF`) for a new capability, otherwise `task`
  (`Implementation task`, `1D76DB`).
- Exactly one of `AFK` (`Can be implemented autonomously`, `0E8A16`) or `HITL` (`Requires human
  interaction`, `FBCA04`). `AFK` when the scope and acceptance criteria are clear and no question is
  open; a cause hypothesis the executor can confirm is not a question.
- Relevant existing area labels.
- `design needed` (`Requires design (mockup + refine) before/with implementation`, `5319E7`) only for
  substantial new UI or a user-facing workflow that needs design exploration.
- The authenticated user as assignee.

Where the provider supports label creation, create only missing labels with these exact values;
never re-normalize existing ones. Where it does not, apply the labels that exist and report the
rest; the HITL section alone marks an Issue `HITL`.
