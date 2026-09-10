# Instruction topology

The canonical shared instruction source lives at `content/instructions/global/AGENTS.md`. A stable native directory alias,
`~/.agents/instructions`, targets `content/instructions`; retarget only that alias when relocating the source checkout.
The native profile instruction links are installed, so native instruction discovery works without MPX and is no longer
suppressed.

## Native profiles and projects

- A Pi profile links `AGENTS.md` to `~/.agents/instructions/global/AGENTS.md` and `APPEND_SYSTEM.md` to
  `~/.agents/instructions/runtime/pi/APPEND_SYSTEM.md`.
- A Claude profile links `AGENTS.md` to the shared global file and uses a regular `CLAUDE.md` containing `@AGENTS.md`.
- Project roots use the native Pi loader files without `MPX_*` routing. Existing valid `CLAUDE.md` symlinks in work
  repositories remain valid; `CLAUDE.md` wrappers are not required to all be regular files.
- Private project instructions live under `~/.agents/private/projects`. The Verotel root and worktree use an
  `AGENTS.override.md` bootstrap and a `CLAUDE.local.md` symlink to their private instructions. Nested FundMe context
  remains in place. For Pi, the bootstrap tells the agent to read the shared and local instructions; this is
  agent-followed routing, not an automatic import. Exclude local instruction files through Git's resolved per-worktree
  `info/exclude` file when appropriate.

Claude can discover nested instruction files natively. Native Pi cannot lazily discover subtree rules in the same way,
so project instruction files must route relevant paths conditionally and explicitly.

## Native skills

Native skills are installed from immutable, compiler-produced, runtime-specific snapshots under
`~/.agents/native-skill-exports/<generation>`. The `~/.agents/skills/mpx` directory junction targets the Pi collection in
the published snapshot. `~/.claude/skills` and `~/.claude-work/skills` remain regular directories and expose compiled
Claude entries and shared content through child junctions. Existing personal legacy `mp-*` skill directories remain
links to their prior sources; native provisioning does not mutate those sources.

The source alias and generated skill snapshots have different roles: `~/.agents/instructions` points to the editable
instruction source of truth, while native skill snapshots are generated publication artifacts. Update skills through
the export and publication process, never by hand-editing a snapshot. Relocating the source checkout only requires
retargeting the instruction alias; it does not retarget or rewrite published skill snapshots.

Use each runtime's native command spelling: `/skill:<name>` in Pi and `/<name>` in Claude. Managed MPX uses
`/mpx:<name>`. Available tools, authentication, and other runtime prerequisites still apply, so native installation does
not imply that every workflow can run without MPX.

## Ownership and sessions

Normal `mpx setup` owns only receipt-owned runtime resources. It does not silently rewrite native profile user files;
the completed one-off native provisioning was separately authorized. Managed Pi continues to pass `--no-skills` to
preserve its own canonical skill catalog, while native instruction discovery remains enabled.

After changing instruction links, instruction files, or published skills, start a fresh session. Use `/reload` only in
runtimes that support it. Existing conversations retain their earlier prompts and do not retroactively acquire updated
instructions.
