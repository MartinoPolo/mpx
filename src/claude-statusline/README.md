# Claude status lines

Claude Code status-line renderers, registered by runtime sync as native Node commands pointing at
these `.mts` scripts.

`scripts/status-line.mts` renders three rows:

```
P · session name · #6fdaff6d · project/worktree
Opus 5 (1M) · ◆◆◆◇◇ · 84k ████░░ · 󰘕 3
5h ██░░ 37% 2h · 7d ████ 62% 3d
```

- Row 1: account badge, session name, short session id linked to the transcript, and a folder label
  linked with a native `file:///` URL: `project/worktree` in a linked worktree, else the folder name.
- Row 2: model, effort gauge, context tokens with a bar measured against the auto-compaction limit
  (color escalates as it fills), and the compaction count once the session has compacted.
- Row 3: 5-hour and weekly quota with reset countdowns, linked to the usage page.

`scripts/subagent-status-line.mts` collapses the tasks panel into one row while sub-agents run
(`● 2 running · 1×Opus 1×Sonnet · 210k tokens · 4m`) and hides the per-agent rows. It keeps no state.

## Constraints

- Render ticks stay cheap and local: one git call and small temp-dir caches, no network, no
  background processes, no credential reads.
- Quota comes from stdin `rate_limits`, falling back to the last-known per-account cache; a cache
  older than 15 minutes shows its age, older than 30 minutes turns the row to a warning, and missing
  data renders as `quota unknown`. A plan without a 5-hour window shows only the weekly one.
- Compaction history is read incrementally from the transcript in bounded chunks per tick.
- `MPX_ACCOUNT` selects the badge; account-scoped state follows `CLAUDE_CONFIG_DIR`.
- Glyphs must exist in plain Cascadia Mono or be Nerd Font Private Use Area icons. Anything else (for
  example `⟳`, `↻`, `✗`) falls back to Segoe UI Emoji and smears double-width over its neighbour, so
  check a new glyph's font cmap before using it.

`statusline-accounts.json` and `statusline-schemes.json` stay beside the package for the theme
loader's relative lookup.
