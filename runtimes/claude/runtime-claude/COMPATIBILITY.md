# Claude runtime integrity boundary

Claude Code does not expose a documented hook that runs atomically between its native
`SKILL.md` read and skill-body expansion. MPX therefore publishes an immutable copy and
uses the earliest available native boundaries:

- `SessionStart` validates the generated launch binding.
- `UserPromptSubmit` revalidates before direct human `/mpx:*` requests are processed.
- `PreToolUse` with the `Skill|Agent|Task|Bash` matcher revalidates before those supported
  native tool calls.

A changed copied skill fails with structured `RESTART_REQUIRED` output and hook exit
code 2. Generated guards conservatively accept at most 1 MiB (1,048,576 UTF-8 bytes)
of hook stdin. They count raw bytes while streaming, retain no more than that limit,
and reject oversized or invalid input as `HOOK_INPUT_INVALID` without waiting for EOF.
These guards detect changes at supported boundaries; they cannot interpose
atomically in Claude's native skill read/expansion. In particular, Pi's exact
open-handle/body-hash checks must not be attributed to Claude.

Native Claude account settings remain authoritative for the main status line; MPX never
writes or mutates `$CLAUDE_CONFIG_DIR/settings.json`. The generated plugin owns its forced
`mpx-terse` output style, hooks, skills, and agents. Plugin `settings.json` contains only
supported plugin defaults and is currently the exact empty object because MPX has no
renderer for Claude's distinct `subagentStatusLine` input schema.

The artifact-local status renderer reads, parses, and validates the live `StatusSnapshotV1`; it does
not revalidate the full published projection. Its artifact-local reader also has a 1 MiB
(1,048,576-byte) allocation limit and renders `ports invalid` for larger or invalid
snapshots. The launcher binds the validated,
read-only Phase C snapshot file through the child-only
`MPX_STATUS_SNAPSHOT_FILE` environment variable. The projection contains a launch
snapshot only as a compatibility fallback for older launchers; it is not refreshed.
Current launchers pass `statusSnapshotPath` to `createClaudeInvocationPlan`, so status
refreshes from the live snapshot.

Phase G lifecycle capture and resume are supported only when the launcher supplies a
validated MPX lifecycle/session binding. Native identifiers are accepted only through
that private binding and validated runtime invocation plan.

Selected MCP routes are read-only, launch-bound stdio configurations. The launcher passes
each validated file with a separate `--mcp-config` argument and adds
`--strict-mcp-config`; it does not mutate Claude account/project MCP configuration or
publish MCP descriptor details through environment variables.
