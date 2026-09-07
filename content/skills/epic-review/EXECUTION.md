# Epic Review Execution and Close-out

Enter only after the HITL gate. Check off or explicitly defer every accepted item; preserve dropped items with
disposition.

## Execute

Count actionable items, excluding Already Tracked and dropped entries.

### At most 20 accepted actions

1. Parent analyzes every item into exact file, location, change, acceptance criterion, and repository-prescribed
   verification command.
2. Group independent file ownership for parallel execution; order dependent changes sequentially.
3. Dispatch named canonical `mpx-executor` agents with pre-analyzed bounded instructions. The agent declares
   `advanced`/low implementation policy. Do not ask executors to redesign, accept work, perform provider operations, or
   commit.
4. After each confirmed group, update corresponding phase-end checkbox to `- [x]`. Leave failed items unchecked with
   evidence.
5. Create only user-approved unresolved follow-ups through the selected `issues.provider` native command, using `task`
   plus exactly one of `AFK`/`HITL`. HITL bodies include open decisions.
6. Add each follow-up to the Epic's deterministic `## Child Issues` list and add reciprocal `## Epic` links. Preserve
   dependency edges in both bodies. Follow [the decomposition template](../to-issues/ISSUE_TEMPLATE.md); do not
   call native parent/sub-Issue APIs.
7. Run repository-prescribed static checks and tests. Use named canonical `mpx-checker` for detected commands when
   available. Record exact command, exit status, and relevant output; do not invent commands.
8. If fixes are substantive, review the resulting aggregate diff again before close-out.

On ambiguous native Issue mutation, reconcile provider state before retrying. If body writeback fails, preserve the
created Issue, leave the tracking action unchecked, and report the exact repair body.

### More than 20 actions or deferral

Save the document and provide a bounded manual handoff. Recommend creating individual approved Issues and using
`/mpx:execute`; do not launch a broad unbounded executor batch.

## Close out

1. Update phase-end final status, dispositions, checks, follow-up IDs/URLs, provider limitations, and remaining human
   work.
2. Read children from the Epic body's `## Child Issues` list and query every state through `issues.provider`; validate
   reciprocal links. Documentary checkboxes do not establish closure.
3. Only when all children and Critical/Important actions are resolved or explicitly deferred, ask:

> All accepted items are resolved or deferred. Close Epic <ID>: "<title>"?

4. Wait for explicit confirmation, then use the selected Issue provider guide's target-bound close command
   (`gh issue close <epic-number> --repo <target>` or `glab issue close <iid> --repo <TARGET>`). Confirm final state
   with the guide's native read command; never claim closure after a failed or ambiguous response.

## Provider boundaries

Resolve `issues.provider` and `repository.provider` independently from nearest valid `mpxconfig.json`. Follow relative
shared provider guides using the parent skill's `CONTENT_PATHS` procedure. Issue create/edit/read/close uses only the
Issue provider. PR and CI evidence uses only the repository provider. If local, KanbanFlow, `none`, missing tooling,
or a provider limitation blocks an operation, continue independent local work, preserve evidence, and return exact
manual steps without a provider switch or invented MPX facade action.
