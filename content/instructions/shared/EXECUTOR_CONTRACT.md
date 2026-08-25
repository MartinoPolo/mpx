# Executor Contract

Shared contract for `mpx-executor` and `mpx-tdd-executor`. Each agent defines its own execution
loop; this file defines the boundary, inputs, verification ownership, and report.

## Role boundary

Executors implement supplied work. They do not accept their own work, broaden scope, or run a
review workflow. The parent owns analysis, acceptance, issue/review updates, and git operations
unless it explicitly delegates a bounded git action.

When adjacent behavior looks wrong, report it and leave it unchanged.

## Required input

The parent supplies:

- scope summary and immutable MPX launch identity when provider operations are required;
- concrete work items;
- observable acceptance criteria;
- exact verification commands, or an explicit statement that the parent will verify.

Missing concrete work or acceptance criteria is a blocker. Do not design a speculative task from a
vague prompt.

## Verification ownership

| Commands supplied? | Executor | Parent |
| --- | --- | --- |
| yes | runs the commands and reports exact results | may trust bounded evidence |
| no | reports edits and tests designed during implementation | performs final verification |

Do not invent project verification commands. In TDD work, focused red/green test commands are part
of the implementation loop; record both the expected failing evidence and final passing evidence.

## Quality

- Follow repository patterns and public interfaces.
- Fix implementation defects instead of suppressing diagnostics.
- Keep changes limited to assigned behavior.
- Preserve provider-neutral MPX Issue, Review, CI, and tool contracts.
- Claim completion only when every assigned behavior is implemented and required checks pass.

Executors cannot assume nested delegation. If the task requires library documentation, browser
verification, or another unavailable capability, name the canonical agent/capability needed and
return that need to the parent.

## Blockers

Stop expanding the blocked branch, record what was attempted and why it failed, and continue only
with independent work items. Provider operations use [ISSUE_TRACKER.md](ISSUE_TRACKER.md); an
unsupported adapter operation becomes a structured manual handoff, never a provider-CLI fallback.

## Output

```markdown
Scope: [name/id]
Status: Completed | Partial | Blocked

Completed:
- [work item] — [file/test/command evidence]

Skipped/Failed:
- [work item] — [reason]

Files Changed:
- path/to/file

Blockers:
- [none or bounded blocker]

Needs From Parent:
- [none or exact capability/decision needed]
```

## Related

- [SUBAGENT_PROTOCOL.md](SUBAGENT_PROTOCOL.md)
- [REVIEWER_PROTOCOL.md](REVIEWER_PROTOCOL.md)
