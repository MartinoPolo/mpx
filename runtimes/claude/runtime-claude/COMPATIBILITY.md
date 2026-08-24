# Claude runtime integrity boundary

Claude Code does not expose a documented hook that runs atomically between its native
`SKILL.md` read and skill-body expansion. MPX therefore projects immutable copied skill
content and uses the earliest available native boundaries:

- `UserPromptSubmit` revalidates before direct human `/mpx:*` requests are processed.
- `PreToolUse` with the `Skill|Agent|Task|Bash` matcher revalidates before supported native Skill
  and Bash tool execution.
- `SessionStart` and `PostToolUse` revalidate session and hook use.
- the status-line command revalidates before reading status.

A changed copied skill fails with structured `RESTART_REQUIRED` output and hook exit
code 2. This detects modification before expansion where Claude emits the above events;
it cannot claim atomic equivalence on Claude versions that read a native skill body
before emitting either `UserPromptSubmit` or `PreToolUse:Skill`.

Live status requires the launcher to bind the validated, read-only Phase C snapshot file
through the child-only `MPX_STATUS_SNAPSHOT_FILE` environment variable. The projection
contains a launch snapshot only as a compatibility fallback for older launchers; it is
not refreshed. Current launchers must pass `statusSnapshotPath` to
`createClaudeInvocationPlan`.
