# Claude status lines

This package carries the Claude Code status-line renderers from the legacy `mpx-claude-code` MP plugin. The layout retains the session/account badge, model and effort with merge-request state, native location links, context and cost details, compaction history, quota state, running-subagent summary, and finished-agent tally.

## Adaptations

- Sub-agents render as summaries only: the tasks panel collapses running agents into one row (count, tiers, tokens, longest elapsed) by emitting empty content for the other rows, and the main bar shows one `Σ` row of finished agents per tier.
- Runtime registration points directly at these `.mts` scripts with the physically resolved Node executable used for synchronization.
- Account-scoped state follows `CLAUDE_CONFIG_DIR`; `MPX_ACCOUNT` is preferred for the visible account badge. Session and agent identifiers reject path separators and traversal.
- Cold compaction history advances through bounded byte chunks over successive ticks; oversized transcript lines are skipped rather than allocated in full.
- Location actions are native `file:///` links. The renderer creates no editor shortcuts or launcher artifacts.
- Quota uses Claude's stdin `rate_limits` and the matching account cache only. It never reads credentials or calls the OAuth usage endpoint; missing data renders as unknown.
- Merge-request and exchange-rate refreshes remain detached, bounded, best-effort processes with hidden Windows child windows. A cold exchange-rate cache never causes synchronous network work.
- Legacy development-server port probing and its project registry are intentionally excluded because Orca owns server visibility.
- Effort presentation does not enforce the retired model-tier/high-ceiling policy. Task payloads lack the declaration identity needed to compare against current runtime profiles; inherited effort stays visibly uncertain.

`statusline-accounts.json` and `statusline-schemes.json` remain adjacent to the package so the copied theme loader's relative lookup stays stable.
