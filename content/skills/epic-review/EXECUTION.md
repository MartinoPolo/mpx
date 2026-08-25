# Epic Review Execution and Close-out

Enter only after the HITL gate.

- For at most 20 accepted actions, analyze exact files and changes, group independent file ownership for concurrent `mp-executor` workers, run dependent changes sequentially, and check off each confirmed result.
- For larger or deferred sets, preserve the phase-end document and provide a manual handoff.
- Create approved follow-up work with `mpx issue create --identity <launch-identity> --json`. Request native parent linkage through `mpx tool invoke --capability issue.sub-issue --identity <launch-identity> --json`; unsupported linkage returns structured remediation and does not erase the Issue.
- Run all repository-prescribed checks after fixes. Review the resulting aggregate diff again when fixes are substantive.
- List open children with `mpx issue list --identity <launch-identity> --json`. Ask for explicit closure authority only when children and Critical/Important actions are resolved or deferred.
- Close with `mpx issue finish --identity <launch-identity> --json`, then confirm state. Never claim closure on a failed response.

Record every accepted item as complete or deferred, all checks, created follow-ups, support limitations, and remaining human action.
