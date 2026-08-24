# Non-normative migration history

> Historical record only. This document does not define current MPX behavior.

# Pi Harness Migration Journal — Historical Implementation Record

This non-normative journal records the completed bootstrap from the Codex desktop app / `~/.codex`
to **pi** ([earendil-works/pi](https://github.com/earendil-works/pi), docs at
[pi.dev/docs/latest](https://pi.dev/docs/latest)), plus its research, acceptance evidence,
Windows findings, and vendor provenance. The sole active migration authority is
[`mpx/MPX_MIGRATION.md`](file:///C:/_MP_projects/mpx/MPX_MIGRATION.md).

Until MPX Phase F/I/J cutover, this repo (`mpx-pi`) remains the live Pi config source and is
symlinked entry-by-entry into each `~/.pi/agent*` root. It is not a permanent independent product:
MPX will import the complete maintained Pi runtime/config tree and archive this journal under
`docs/history/`. Native account auth, sessions, trust, packages, and caches remain outside every
repository.

**Historical execution began 2026-07-31.** The phase findings below explain the current Pi
implementation. Remaining actions are governed by the MPX plan rather than by this journal.

## Why

- `~/.codex` is a hand-duplicated mirror of the Claude config and has already drifted:
  `pre-commit-gate.js` secret-regex differs by a `\b`, `notify-flash-beep.ps1` copies diverged
  (3656 B vs 4217 B), Codex has 19 agent `.toml`s and zero skills vs the repo's 24 agents /
  50 skills. pi reads the same source files `mpx-claude-code` already maintains.
- pi has native ChatGPT/Codex subscription OAuth (`/login` → "ChatGPT Plus/Pro (Codex
  Subscription)"), a <1,000-token replaceable system prompt, and an in-process TypeScript
  extension API that can host ports of the statusline and hooks with far fewer workarounds than
  Claude Code's stdin-per-tick model needed.

## Key decisions

| Decision | Rejected alternative | Why |
| --- | --- | --- |
| pi is the Codex harness | Codex CLI | No custom statusline hook (fixed enum only, [openai/codex#17827](https://github.com/openai/codex/issues/17827) open); hooks unavailable on native Windows |
| pi over OpenCode | OpenCode | OpenCode maintainers twice declined an in-TUI statusline hook; ChatGPT auth is a community plugin there vs native in pi |
| Config source lives in this repo (`mpx-pi`), symlinked into `~/.pi/agent/` entry by entry | Symlink the whole `~/.pi/agent/` dir; or a `pi/` folder inside `mpx-claude-code` | `auth.json` (secrets) and `sessions/` (runtime data) must stay out of the repo; `mpx-claude-code` is Claude-only by owner decision |
| One custom footer extension, ported from `mpx-claude-code/scripts/` | Stack `kreeger/pi-statusbar` + `nicobailon/pi-powerline-footer` + patches | A third of the features are custom anyway; one extension is less to maintain across pi updates. Community extensions are **reference code**, not installed dependencies |
| Skip Claude models in pi entirely | Claude Pro/Max OAuth in pi; SDK bridges (Meridian) | Since 2026-04-04, third-party Claude OAuth bills as per-token "extra usage", not plan limits. Claude stays in Claude Code. Revisit if Anthropic ships the reworked Agent SDK credit plan (announced 2026-05-14, paused 2026-06-15) |
| Reuse the existing Node hook scripts via a thin TS wrapper | Rewrite hooks natively in the extension | Zero behavior drift from the Claude side; the `.js` files in `mpx-claude-code/hooks/` remain the single source |
| Guardrails, not permission prompts | Rebuild an allowlist/prompt system | pi's default (no prompts, everything runs) matches the `defaultMode: auto` habit; the four guard hooks are what made auto safe and they port 1:1 to a blocking `tool_call` handler |

## Target layout

This repo's root:

```
mpx-pi/
  settings.json          # pi global settings (model, thinking, compaction, enabled extensions)
  subagents.json         # global subagent UI settings
  APPEND_SYSTEM.md       # shared prompt additions layered onto pi's built-in prompt
  extensions/
    auto-title.ts        # names unnamed sessions after their first settled turn
    guard-hooks.ts       # wraps mpx-claude-code/hooks/*.js  (Phase 5)
    footer.ts            # statusline port                    (Phase 7)
    subagents/           # forked pi-subagents extension      (Phases 6-7)
  agents/                # subagent .md definitions, generated from mpx-claude-code/agents/ (Phase 6)
  prompts/               # slash-command prompt templates, where needed
  skills/                # pi-adapted skill copies only; harness-neutral skills link straight
                         # to mpx-claude-code/skills/ (Phase 4)
  PI_MIGRATION.md        # historical implementation journal + findings/provenance
```

Symlink map (create every link with `cmd /c mklink` — `/D` for directories — from the PowerShell
tool; PowerShell 5.1's `New-Item -ItemType SymbolicLink` fails with an admin error and Git Bash
`ln -s` silently copies. See Phase 2 findings, and `mpx-pi/skills/mp-symlink/SKILL.md` for the
corrected pattern):

| Link (`<account-agent-dir>/…`) | Target |
| --- | --- |
| `AGENTS.md` | `C:/_MP_projects/mpx-claude-code/instructions/AGENTS.md` (same file Claude Code and Codex read today) |
| `APPEND_SYSTEM.md` | `C:/_MP_projects/mpx-pi/APPEND_SYSTEM.md` |
| `settings.json` | `C:/_MP_projects/mpx-pi/settings.json` |
| `subagents.json` | `C:/_MP_projects/mpx-pi/subagents.json` |
| `extensions` | `C:/_MP_projects/mpx-pi/extensions` |
| `themes` | `C:/_MP_projects/mpx-pi/themes` |
| `agents` | `C:/_MP_projects/mpx-pi/agents` |
| `prompts` | `C:/_MP_projects/mpx-pi/prompts` |
| `skills` | **real directory, never a link** — each chosen skill folder is linked individually inside it (Phase 4) |
| `skills/mp-symlink` | `C:/_MP_projects/mpx-pi/skills/mp-symlink` (pi-adapted copy) |
| `skills/mp-sync-base` | `C:/_MP_projects/mpx-pi/skills/mp-sync-base` (pi-adapted copy) |
| `skills/mp-fallow-fix` | `C:/_MP_projects/mpx-claude-code/skills/mp-fallow-fix` |
| `skills/mp-vocabulary` | `C:/_MP_projects/mpx-claude-code/skills/mp-vocabulary` |

Left real in each account agent directory (never in the repo): `auth.json`, `sessions/`, trust,
packages, and caches. The personal launcher selects `~/.pi/agent`; the work launcher selects
`~/.pi/agent-work` through `PI_CODING_AGENT_DIR`. Create additional account roots with
`scripts/setup-account-profile.sh <directory>`.

## Historical phases

The imperative wording and acceptance checks below are preserved as an execution record. Do not
start or track new migration work from these sections; amend the owning MPX phase instead.

### Phase 1 — Install and verify assumptions (~1h, do first)

1. Install pi globally (verify the exact package/command from [pi.dev/docs/latest](https://pi.dev/docs/latest);
   research says the CLI package is `@earendil-works/pi-coding-agent`). Windows prerequisite is
   Git Bash at `C:\Program Files\Git\bin\bash.exe` — already present on this machine.
2. `/login` → ChatGPT Plus/Pro (Codex Subscription); confirm a codex model responds. Pick the
   default model from what the subscription actually offers (`/model`) — do not assume a name.
   **DEFERRED TO HUMAN (2026-07-31)** — interactive OAuth, cannot be driven by an agent. Run
   `pi` then `/login` → "OpenAI (ChatGPT Plus/Pro)". Everything else in Phase 1 is done.
3. Verify the claims this plan depends on, in order of load-bearing-ness (agents: verify by
   reading the installed package source under `npm root -g` where the TUI can't be driven):
   - `ctx.ui.setFooter` / `setWidget` / `setStatus` exist and render multi-line ANSI (try
     `examples/extensions/custom-footer.ts`).
   - OSC-8 hyperlinks survive to Windows Terminal (emit one `file:` link from a test footer).
   - `.pi/SYSTEM.md` replaces the prompt; **test `APPEND_SYSTEM.md`** —
     [earendil-works/pi#748](https://github.com/earendil-works/pi/issues/748) says auto-discovery
     may be missing; fallback is a `before_agent_start` hook.
   - `tool_call` event can block with a reason.
   - Install and poke: [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)
     (widget fields, agent `.md` format), [timm-u/pi-usage](https://github.com/timm-u/pi-usage)
     or [carlosarraes/pi-codex-status](https://github.com/carlosarraes/pi-codex-status) (Codex
     5h/weekly quota), `pi-mcp-adapter` (bridge to the existing chrome-devtools MCP server),
     [@upstash/context7-pi](https://www.npmjs.com/package/@upstash/context7-pi),
     `pi-patty-bg-tasks` (background bash), `josephkern/pi-memory`.

**Accept:** pi answers a coding prompt via the Codex subscription; every bullet above marked
works / broken-with-fallback in this doc.

#### Findings (2026-07-31)

**Installed:** `npm install -g @earendil-works/pi-coding-agent` → **v0.83.0**, CLI command `pi`
(`bin: { pi: "dist/cli.js" }`). `pi --version` → `0.83.0`. Node v22.23.1 via fnm.
Package source read at `<npm root -g>/@earendil-works/pi-coding-agent/` — it ships full `docs/`,
`examples/extensions/`, and `.d.ts` typings, so every claim below is source-verified.
The installer created only `~/.pi/agent/auth.json` and `~/.pi/agent/models-store.json`
(both empty `{}`); nothing else was written.

| # | Item | Verdict | Detail (source path relative to the package root) |
| --- | --- | --- | --- |
| a | Extension auto-load + `/reload` | **CONFIRMED** | `~/.pi/agent/extensions/*.ts`, `~/.pi/agent/extensions/*/index.ts`, `.pi/extensions/*.ts`, `.pi/extensions/*/index.ts` (`docs/extensions.md:117-120`). `/reload` is a built-in command: "Reload keybindings, extensions, skills, prompts, themes, and context files" (`dist/core/slash-commands.js:23`). `pi -e <path>` loads without discovery. |
| b | `pi.on()` / `ctx.ui.*` | **CONFIRMED with a correction** | `pi.on(event, handler)` (`dist/core/extensions/types.d.ts:856-888`). `setStatus(key, text)` and `setWidget(key, content, {placement:"aboveEditor"\|"belowEditor"})` exist; `setWidget` accepts `string[]` directly = multi-line ANSI, no component needed. **`setFooter` takes a component factory, not a string**: `setFooter((tui, theme, footerData) => ({ render(width): string[], dispose?() }))` (`types.d.ts:107-109`, example `examples/extensions/custom-footer.ts`). The returned `string[]` is one raw ANSI string per line ⇒ **multi-line ANSI footers work**. `footerData` (`ReadonlyFooterDataProvider`) supplies `getGitBranch()`, `getExtensionStatuses()`, `onBranchChange(cb)`; everything else comes off `ctx.sessionManager` / `ctx.model`. |
| c | Event list + `tool_call` block shape | **CONFIRMED** | 25 events, exact names in `dist/core/extensions/types.d.ts:773` and the lifecycle diagram at `docs/extensions.md:280-312`. `ToolCallEventResult = { block?: boolean; reason?: string }` (`types.d.ts:778-782`) — the plan's `{block: true, reason}` is exact. Tool args are patched by **mutating `event.input` in place** (no return field for that). `ToolResultEventResult = { content?, details?, isError?, usage? }` (`types.d.ts:790-795`). Session: `session_start` (with `reason: "startup"\|"reload"\|"new"\|"resume"\|"fork"`), `session_before_compact`, `session_compact` (both carry `reason: "manual"\|"threshold"\|"overflow"`), `session_shutdown`. End of turn: see **Open question 1** below. |
| d | `SYSTEM.md` / `APPEND_SYSTEM.md` | **CONFIRMED — issue #748 is stale** | Auto-discovery exists: `DefaultResourceLoader.discoverSystemPromptFile()` and `.discoverAppendSystemPromptFile()` at `dist/core/resource-loader.js:808-828`. Order per file: project `<cwd>/.pi/SYSTEM.md` **only when the project is trusted**, else global `~/.pi/agent/SYSTEM.md`. Identical logic for `APPEND_SYSTEM.md`. First match wins — project and global are **not** concatenated. Both names are on the trust-gated list (`dist/core/trust-manager.js:13-14`). No `before_agent_start` fallback needed. |
| e | Settings path + schema | **CONFIRMED** | Global `~/.pi/agent/settings.json`, project `<cwd>/.pi/settings.json` (`dist/config.js:433`, `FileSettingsStorage`). Interface `Settings` at `dist/core/settings-manager.d.ts:61-107`. Keys we need: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `extensions: string[]`, `packages: PackageSource[]`, `skills`, `prompts`, `themes`, `enabledModels: string[]`, `enableSkillCommands`, `theme`, `quietStartup`, `shellPath`, `compaction: { enabled?, reserveTokens?, keepRecentTokens? }`, `thinkingBudgets: { minimal?, low?, medium?, high? }`, `sessionDir`, `defaultProjectTrust: "ask"\|"always"\|"never"`. |
| f | Thinking levels | **CONFIRMED** | `off, minimal, low, medium, high, xhigh, max` — verbatim from `pi --help` (`--thinking <level>`). Per-model support is declared by `thinkingLevelMap`; a level mapped to `null` is unsupported and `setThinkingLevel` clamps to model capability. |
| g | Codex OAuth + model IDs | **CONFIRMED** | Provider `openai-codex`, display name **"OpenAI (ChatGPT Plus/Pro)"**, `baseUrl: https://chatgpt.com/backend-api`, api `openai-codex-responses` (`node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js`). OAuth flow against `https://auth.openai.com`, stores `chatgpt_account_id` (`.../pi-ai/dist/auth/oauth/openai-codex.js`). Tokens land in **`~/.pi/agent/auth.json`** (`dist/config.js:427-430`, `dist/core/auth-storage.d.ts`). Catalog (`.../pi-ai/dist/providers/data/openai-codex.json`) defines 7 models: `gpt-5.3-codex-spark` (128k ctx), `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` (272k ctx / 128k max out each). Only the `-luna/-sol/-terra` trio maps the `max` thinking level; all map `xhigh`. **Which of these the subscription actually grants is unknown until `/login`.** |
| h | `AGENTS.md` / `CLAUDE.md` loading | **CONFIRMED with a caveat** | `loadContextFileFromDir` tries `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` and returns the **first** hit — one file per directory, so a repo holding both loads only `AGENTS.md` (`dist/core/resource-loader.js:32-50`). `loadProjectContextFiles` loads global `~/.pi/agent/AGENTS.md` first, then every ancestor from filesystem root down to cwd, de-duplicated, with linked-worktree shadowing handled (`resource-loader.js:81-107`). Disable with `--no-context-files` / `-nc`. |
| i | OSC-8 hyperlinks in pi-tui | **CONFIRMED** | `hyperlink(text: string, url: string): string` is a public export of `@earendil-works/pi-tui` (`pi-tui/dist/terminal-image.d.ts:88`), emitting `\x1b]8;;<url>\x1b\\<text>\x1b]8;;\x1b\\`. The line-wrapper's `AnsiCodeTracker` parses OSC-8 and **re-opens the link on each wrapped physical line, preserving the original BEL-vs-ST terminator** (`pi-tui/dist/utils.js:315-350`) — raw escape sequences in footer/widget strings pass through intact. |
| j | Subagents | **Example SHIPS; frontmatter is thinner than needed** | `examples/extensions/subagent/` ships (`index.ts` 35 KB, `agents.ts`, 4 sample agents, 3 workflow prompts). Frontmatter it parses: **`name`, `description`, `tools` (comma-separated), `model`** — no `thinking`, no concurrency limit (`examples/extensions/subagent/agents.ts:52-71`). Agents load from `~/.pi/agent/agents/*.md` and the nearest ancestor `.pi/agents/` (`agents.ts:85-102`). Each subagent runs as a **separate `pi` child process**. See **Open question 2** for the recommendation. |
| k | Skills + prompt templates | **CONFIRMED** | Skills auto-load from `~/.pi/agent/skills/` and `<cwd>/.pi/skills/` (`dist/core/resource-loader.js:622,628`), SKILL.md-standard discovery (dir containing `SKILL.md` = skill root, no recursion below it) and register as **`/skill:name`** (`dist/modes/interactive/interactive-mode.js:407`, `docs/skills.md:75-79`). Frontmatter: `name`, `description`, `disable-model-invocation` (`dist/core/skills.d.ts:3-8`) — the last hides the skill from the system prompt while keeping `/skill:name` usable, exactly what a cautious Phase 4 rollout wants. Prompt templates from `~/.pi/agent/prompts/` and `.pi/prompts/`. |
| l | Codex quota headers | **NOT IN PI — extension must fetch it** | Pi ships **no** `x-codex-*` handling; the codex API layer only pattern-matches `usage_limit_reached\|usage_not_included\|rate_limit_exceeded` and HTTP 429 (`pi-ai/dist/api/openai-codex-responses.js:1202`). The hook is `after_provider_response` → `{ status: number, headers: Record<string,string> }`, fired before the stream body is consumed (`types.d.ts:517-522`, `docs/extensions.md:695-709`, note "header availability depends on provider and transport"). Community technique: `carlosarraes/pi-codex-status` and `mtrojnar/pi-usage` (successor to the now-archived `timm-u/pi-usage`) both GET **`https://chatgpt.com/backend-api/wham/usage`** with the stored OAuth bearer, which returns plan + 5h/weekly reset without spending a model request; `mtrojnar/pi-usage` additionally refreshes passively off `x-codex-*` headers seen in `after_provider_response`. **Handy discovery:** `pi auth print-bearer-token --provider openai-codex --model gpt-5.5` prints a fresh (auto-refreshed) bearer, so the footer extension does not have to parse `auth.json` itself. |

**Bonus verifications for later phases**

- Compaction trigger formula is documented, no reverse-engineering: `contextTokens > contextWindow - reserveTokens`; defaults `reserveTokens: 16384`, `keepRecentTokens: 20000`, `enabled: true` (`docs/compaction.md:32-35,385-400`). Phase 7 item 2 stands as written.
- `ctx.getContextUsage()` returns `{ tokens: number|null, contextWindow: number, percent: number|null }` — `tokens` is `null` right after compaction until the next LLM response, so the context bar needs a null branch (`types.d.ts:193-199`).
- `agent_settled` carries no payload; `agent_end` carries `messages: AgentMessage[]`; `turn_end` carries `{ turnIndex, message, toolResults }` — the Σ tally in Phase 7 item 11 is best fed by `turn_end`/`agent_end`, the notify beep by `agent_settled`.
- Extra useful examples shipped for the ports: `status-line.ts`, `custom-footer.ts`, `permission-gate.ts`, `confirm-destructive.ts`, `protected-paths.ts`, `dirty-repo-guard.ts`, `notify.ts`, `provider-payload.ts`, `custom-compaction.ts`, `claude-rules.ts`, `widget-placement.ts`.

**Assumptions that changed:**

1. `setFooter` is a **component factory**, not a string sink (row b) — the Phase 7 port renders into `render(width): string[]` rather than returning a formatted string. `setWidget` is the string-array API.
2. There is **no `gpt-5.x-codex` model** in the registry apart from `gpt-5.3-codex-spark`; the subscription models are plain `gpt-5.4`/`gpt-5.5`/`gpt-5.6-*`. Phase 4's "write `SYSTEM.md` for gpt-5.x-codex" should target whichever of these `/login` exposes, and the Codex-CLI prompt lineage is still the right starting point but is not a guaranteed RL match.
3. Issue [earendil-works/pi#748](https://github.com/earendil-works/pi/issues/748) no longer applies at v0.83.0 — the `before_agent_start` fallback for `APPEND_SYSTEM.md` is unnecessary. **But** project-scoped `.pi/SYSTEM.md` needs project trust, so plan on `defaultProjectTrust` or an explicit `--approve`.
4. `AGENTS.md` and `CLAUDE.md` in the same directory are **not** both loaded — first match wins. `mpx-claude-code` holds both; pi will read only `AGENTS.md` there, which is the intended file anyway.

### Phase 2 — Repo structure + symlinks

Create the layout above (empty extension stubs are fine), make the symlinks, restart pi,
confirm it loads `AGENTS.md` (it walks up from cwd and reads global `~/.pi/agent/AGENTS.md`;
it accepts both `AGENTS.md` and `CLAUDE.md` names).

**Accept:** pi session shows repo instructions are active (ask it what output style it must use).

#### Findings (2026-07-31)

All five links exist as **real `SymbolicLink`s** (not junctions, not copies), verified with
`Get-Item <link> | Select-Object LinkType, Target` and by reading content through each link.

| Link (`~/.pi/agent/…`) | Target | Type | Read-through check |
| --- | --- | --- | --- |
| `AGENTS.md` | `C:\_MP_projects\mpx-claude-code\instructions\AGENTS.md` | SymbolicLink | first line `## Output style` |
| `settings.json` | `C:\_MP_projects\mpx-pi\settings.json` | SymbolicLink | full JSON body reads back |
| `extensions` | `C:\_MP_projects\mpx-pi\extensions` | SymbolicLink (`/D`) | lists `.gitkeep` |
| `agents` | `C:\_MP_projects\mpx-pi\agents` | SymbolicLink (`/D`) | lists `.gitkeep` |
| `prompts` | `C:\_MP_projects\mpx-pi\prompts` | SymbolicLink (`/D`) | lists `.gitkeep` |
| `skills` | — | **not created**, as planned | — |

`auth.json` and `models-store.json` remain real files, untouched. `sessions/` does not exist yet.

**Deviation — `New-Item -ItemType SymbolicLink` is unusable on this machine.** Every one of the
five failed with `Administrator privilege required for this operation.` even though Developer
Mode **is** on (`HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock\
AllowDevelopmentWithoutDevLicense = 1`). Cause: **Windows PowerShell 5.1** — the only PowerShell
on this box, no `pwsh` installed — does not pass `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`,
so Developer Mode cannot help it. `cmd /c mklink` (and `mklink /D`) **does** pass the flag and
creates true symlinks unprivileged; that is what was used, after a throwaway probe confirmed
`LinkType = SymbolicLink`. No elevation, no UAC prompt, no file copying.
**Follow-up:** the `/mp-symlink` skill in `mpx-claude-code` still says file symlinks need
elevation or Developer Mode via `New-Item` and recommends junctions for directories — it should
be updated to the `cmd /c mklink` path (or to install `pwsh`). Also note its claim that
`cmd.exe //c "mklink ..."` fails is true only from the **Bash** tool; from the **PowerShell**
tool `cmd /c mklink "<link>" "<target>"` works cleanly.

**Repo structure:** `.gitkeep` added to `agents/`, `prompts/` **and `extensions/`** (all three
were untracked-because-empty; `extensions/` got one too so the directory symlink survives a
fresh clone).

**Accept:** structure + links verified headlessly. The "pi session shows repo instructions are
active" half needs the TUI and is pending the human `/login`.

### Phase 3 — settings.json

Populate `settings.json`: `defaultModel` (from Phase 1), `defaultThinkingLevel` (start
`medium`; the Codex desktop config ran `model_reasoning_effort = low` — tune later), compaction
(`reserveTokens`, `keepRecentTokens` defaults are fine to start), enabled `extensions` array.

**Accept:** fresh pi session starts with the chosen model/thinking without manual `/model`.

#### Findings (2026-07-31)

[`settings.json`](file:///C:/_MP_projects/mpx-pi/settings.json) as written:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "medium",
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
  "extensions": []
}
```

Every key re-checked against `Settings` in
`<npm root -g>/@earendil-works/pi-coding-agent/dist/core/settings-manager.d.ts:61-107` and
`CompactionSettings` at `:3-7` — all five are real fields, no invented names.

| Key | Value | Rationale |
| --- | --- | --- |
| `defaultProvider` | `openai-codex` | Exact provider id in `pi-ai/dist/providers/openai-codex.js`; display name "OpenAI (ChatGPT Plus/Pro)" |
| `defaultModel` | `gpt-5.6-sol` | Mirrors the Codex desktop `config.toml` choice. Catalog: 272k ctx / 128k max-out, `thinkingLevelMap` includes `max` **and** `xhigh`. **Must be confirmed after `/login` + `/model`** — the catalog lists it, but whether the subscription grants it is unknown until then |
| `defaultThinkingLevel` | `medium` | Plan default. `medium` is not remapped by `gpt-5.6-sol`'s `thinkingLevelMap` (only `xhigh`, `max`, `minimal` are), so it passes through as-is |
| `compaction` | `{true, 16384, 20000}` | The verified defaults, stated explicitly so a pi upgrade changing them is a visible diff |
| `extensions` | `[]` | See below — likely stays empty permanently |
| `defaultProjectTrust` | **omitted** | Global `~/.pi/agent/SYSTEM.md` needs no trust (Phase 1 finding d). A project-scoped `.pi/SYSTEM.md`, `.pi/settings.json`, or `.pi/extensions/` **would** need it — set `"defaultProjectTrust": "always"` or pass `--approve` when Phase 4/5 moves anything project-scoped |

**Do extensions auto-load without being listed? YES.** `docs/extensions.md:110-136`: extensions are
auto-discovered from `~/.pi/agent/extensions/*.ts`, `~/.pi/agent/extensions/*/index.ts`,
`.pi/extensions/*.ts`, `.pi/extensions/*/index.ts`. The `extensions: string[]` setting is for
**additional paths outside those directories**, and `packages: PackageSource[]` is for
npm/git-installed pi packages. Since `~/.pi/agent/extensions` is symlinked to this repo's
`extensions/`, Phases 5–7 drop `.ts` files in and they load with **no settings change** —
`extensions` stays `[]`. It gains entries only if an extension has to live outside the repo, and
`packages` gains one if `pi install npm:@tintinweb/pi-subagents` is used in Phase 6.

**Gotcha — settings.json must be BOM-free.** PowerShell 5.1's `Set-Content -Encoding utf8` /
`Out-File` write a UTF-8 BOM, and pi's `JSON.parse` chokes on it:
`Warning: (startup session lookup, global settings) Unexpected token '﻿', "﻿{ "defaul"... is not
valid JSON` — a **warning**, not an error, so pi starts anyway and silently ignores every setting.
Always write this file BOM-free (`[System.IO.File]::WriteAllText($p, $t, (New-Object
System.Text.UTF8Encoding($false)))`, or any non-PowerShell writer).

**Accept: verified headlessly; TUI confirmation pending login.**

- pi genuinely reads the file *through the symlink* — proven by deliberately corrupting the repo
  copy and seeing the "global settings … not valid JSON" warning appear, then vanish once
  restored. That warning path is the only settings validator pi has; there is no
  `pi doctor`/`pi config --validate` non-interactive command (`pi config` opens a TUI).
- `pi --list-models` currently lists **google only** — `--list-models` shows providers that have
  credentials, and `~/.pi/agent/auth.json` is still `{}`. The seven `openai-codex` models will
  appear after `/login`; `pi --list-models gpt-5.6` returning "No models matching" right now is
  expected, not a settings problem.
- Remaining human check after `/login`: open `pi`, confirm the footer shows `gpt-5.6-sol` at
  thinking `medium` with no manual `/model`, and that `/model` actually offers `gpt-5.6-sol`. If
  the subscription does not grant it, change `defaultModel` here and re-record.

### Phase 4 — System prompt + skills exposure

- Write `SYSTEM.md` for gpt-5.x-codex. Start from the shipped Codex CLI prompts
  ([codex-rs/core](https://github.com/openai/codex/tree/main/codex-rs/core), e.g.
  `gpt_5_2_prompt.md`) because the model is RL-trained against them. Keep: AGENTS.md precedence
  rules, ASCII-by-default, "never revert unrelated dirty-worktree changes", plan-skip-for-trivial
  heuristic. Rewrite tool references to pi's `read/write/edit/bash`. **Cut** preamble/status-
  narration instructions (OpenAI's own guidance: they cause premature stopping). Keep the whole
  thing minimal — every paragraph must encode something the model can't infer.
- Skills: do **not** symlink mpx-claude-code's 50 skills. Most `mp-*` skills name Claude Code
  agent types, the Agent tool, or Claude-only features and will misfire under pi. Start with a
  hand-picked set that is harness-neutral (git/utility candidates), copied or linked
  individually into `~/.pi/agent/skills/`. Audit each skill's body for Claude-specific
  references before enabling. Expand later; porting the pipeline skills (`mp-execute` etc.) is
  explicitly out of scope for this migration.

**Accept:** pi session uses the custom prompt (ask it to state its instructions); the chosen
skills appear as `/skill:name` and run.

#### Findings (2026-07-31)

**Base prompt file: [`codex-rs/core/gpt-5.2-codex_prompt.md`](https://github.com/openai/codex/blob/main/codex-rs/core/gpt-5.2-codex_prompt.md)**
(7,589 B), plus the `## AGENTS.md spec` section lifted from
[`gpt_5_2_prompt.md`](https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md)
(21,652 B). Those are the newest in the lineage: `codex-rs/core` currently ships exactly six
prompt files — `gpt_5_codex_prompt.md`, `gpt_5_1_prompt.md`, `gpt-5.1-codex-max_prompt.md`,
`gpt_5_2_prompt.md`, `gpt-5.2-codex_prompt.md`, `prompt_with_apply_patch_instructions.md`. There
is **no 5.3+/sol/luna/terra prompt in the repo**, so the RL match for `gpt-5.6-sol` is
approximate, exactly as assumption-change 2 in Phase 1 predicted. `gpt-5.1-codex-max_prompt.md`
is byte-identical in size to the 5.2 file; the `-codex` variants are the short ones (~7.6 KB)
and the plain ones the long ones (~22 KB), because the long files carry the sandbox/approval and
final-answer-formatting machinery that the codex-tuned models have internalised.

**Historical artifact:** `SYSTEM.md` was written during this phase and was later replaced by the
active [`APPEND_SYSTEM.md`](file:///C:/_MP_projects/mpx-pi/APPEND_SYSTEM.md), which layers shared
instructions onto Pi's built-in prompt instead of replacing it.

| Kept | Cut | Rewritten |
| --- | --- | --- |
| AGENTS.md scope + precedence (nested wins, conversation outranks) | Whole "Presenting your work / Final answer structure" block (~90 lines) — `AGENTS.md` § Output style already dictates format, links, tables, HITL | `apply_patch` → `edit`/`write` split |
| ASCII-by-default | Preamble / status-update narration — OpenAI's own guidance is that it causes premature stopping | `update_plan` → "no plan or todo tool exists; never call one", keeping the skip-the-easiest-25% heuristic |
| Dirty-worktree rules (never revert the user's changes; stop on unexpected changes) | Personality, verbosity budgets, tone — `AGENTS.md` owns these | `rg`/`cat`/`sed` shell advice → prefer pi's `grep`/`find`/`ls`/`read` tools |
| Skip-the-plan-for-trivial-tasks heuristic | Frontend "avoid AI slop" section — the design pipeline lives in the `mp-design-*` skills, which are out of scope here | Sandbox/approval modes → one line: pi has neither, commands take effect immediately |
| No destructive git, no amend, no unasked commits/branches | "Run `date` for simple requests", inline-citation ban, `multi_tool_use.parallel` naming | — |
| Autonomy: implement rather than propose | Root-cause / naming / comment rules — `AGENTS.md` § Code already says them | — |
| Review-request → code-review mindset | Skills usage, cwd, project-context wiring — pi's harness appends all three itself | — |
| Test-narrow-then-widen, don't fix unrelated bugs, no license headers | | |

Two machine facts were **added** (nothing in the Codex lineage covers them): pi's `bash` tool is
**Git Bash**, so Windows-native work needs an explicit `powershell.exe -NoProfile -Command` or
`cmd //c` call; and **nothing gates tool calls** — no sandbox, no approval prompt.

**pi's exact tool names — verified, not assumed:**
`ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls"`
(`dist/core/tools/index.d.ts:21`, files `dist/core/tools/{read,bash,edit,write,grep,find,ls}.js`).
There is **no plan/todo tool and no `apply_patch`** — `grep -r "update_plan\|todo_write"` over
`dist/` returns nothing. What pi already tells the model when `SYSTEM.md` is present
(`dist/core/system-prompt.js:13-33`): the `<project_context>` wrapper around every `AGENTS.md`,
the `<available_skills>` block, and a trailing `Current working directory:` line — and
**nothing else**, since the custom-prompt branch skips the built-in tools list and guidelines
entirely. Per-tool guidelines that the built-in prompt would have added and `SYSTEM.md` now
restates deliberately: `"Use read to examine files instead of cat or sed."` (`read.js:138`) and
`"Use write only for new files or complete rewrites."` (`write.js:138`).

**Skills.** `~/.pi/agent/skills/` created as a **real directory**; each skill is a directory
symlink inside it. Safe: pi's discovery explicitly stats symlinked entries and follows them
(`dist/core/skills.js:171-183`), and `existsSync` follows the `SYSTEM.md` link
(`resource-loader.js:808-818`, global path needs no project trust).

| Skill | Source | Audit verdict |
| --- | --- | --- |
| `mp-symlink` | **adapted copy** in `mpx-pi/skills/` | Original is Claude-Code-specific *and wrong for this machine* — it mandates `New-Item`, which Phase 2 proved fails here. Rewritten around `cmd //c mklink` driven from pi's `bash` tool; every command in it was executed and verified (file + dir links, absolute and relative, `rm` on a dir symlink leaves the target intact) |
| `mp-sync-base` | **adapted copy** in `mpx-pi/skills/` | Body is pure `git`; only Claude couplings were `node $HOME/.claude/scripts/detect-base-branch.js` (repointed at `C:/_MP_projects/mpx-claude-code/scripts/detect-base-branch.js`), "use Read/Edit tool" (→ `read`/`edit`), and a trailing "list agents dispatched" line (dropped) |
| `mp-fallow-fix` | link → `mpx-claude-code/skills/mp-fallow-fix` | Clean. No agent types, no Agent tool, no relative or `~/.claude` paths; body is `pnpm fallow:*` commands and a suppression table |
| `mp-vocabulary` | link → `mpx-claude-code/skills/mp-vocabulary` | Clean. `AskUserQuestion` appears only in `allowed-tools`, which **pi never reads** (`grep -r "allowed-tools" dist/` → no hits; docs mark it experimental); the body just says "ask the user" |

Rejected, with the disqualifying reference:

- `mp-commit` / `mp-commit-push` / `mp-commit-push-pr` / `mp-pr` — delegate to the
  `mp-git-committer` agent and read `${CLAUDE_SKILL_DIR}/../shared/GIT_COMMIT_WORKFLOW.md`.
- `mp-clean-pc` — `Agent`/`Artifact`/`AskUserQuestion` tools, `${CLAUDE_SKILL_DIR}/scripts/`,
  `~/.claude/mp-clean-pc/state.json`, and reasoning about the `dangerous-command-guard.js` hook's
  `matcher: "Bash"`.
- `mp-hitl`, `mp-bug-report`, `mp-to-prd`, `mp-grill`, `mp-components-audit`,
  `mp-suppression-audit`, `mp-code-clean`, `mp-decompose`, `notebooklm` — all spawn `Explore`,
  `mp-executor`, `mp-issue-analyzer`, or `general-purpose` sub-agents.
- **Near misses, deferred:** `mp-script-discovery` and `mp-consolidate-context` are otherwise
  clean. The first hard-codes `$HOME/.claude/scripts/detect-project-scripts.sh`; the second points
  at `skills/shared/DOCUMENTATION_STRATEGY.md`, which does not resolve from a symlinked skill
  directory. Each needs a one-line path fix in an adapted copy — worth doing once the base
  harness is in daily use.

Note that three of the four are `disable-model-invocation: true`, so only `mp-symlink` reaches the
system prompt; the rest are `/skill:name`-only. That is the cautious rollout Phase 1 finding k
described, and it happens to match the source skills' existing frontmatter.

**Settings change:** one line — `"enableSkillCommands": true` in
[`settings.json`](file:///C:/_MP_projects/mpx-pi/settings.json). It is already the default
(`dist/core/settings-manager.js:748` → `?? true`), pinned for the same reason the compaction
defaults are pinned: three of the four skills are reachable *only* through `/skill:name`, so a pi
upgrade flipping that default would silently make them unreachable. No `skills[]` entry is needed —
`~/.pi/agent/skills/` is a default discovery root. Written BOM-free; re-validated with
`JSON.parse`.

**Accept: layout verified against loader source; TUI confirmation pending login.** pi ships no
`--print-system-prompt` flag, so verification ran pi's own loader in-process — a throwaway
`node --input-type=module` script importing `dist/core/skills.js` and calling
`loadSkills({ cwd, agentDir: ~/.pi/agent, skillPaths: [], includeDefaults: true })`:

- `SYSTEM.md discovered: true`, first line reads back through the symlink.
- `skills discovered: 4` — `mp-fallow-fix`, `mp-symlink`, `mp-sync-base`, `mp-vocabulary`, each
  resolved at `C:\Users\snapy\.pi\agent\skills\<name>\SKILL.md`.
- `diagnostics: []` — no frontmatter warnings, no name collisions.
- `formatSkillsForPrompt()` emits an `<available_skills>` block containing `mp-symlink` only,
  confirming `disable-model-invocation` is honoured.

`pi --verbose -p "say ok"` additionally started cleanly (no settings/skills/prompt warnings)
before failing at the provider — it fell back to a Google model, since `openai-codex` still has no
credentials. Remaining human check after `/login`: ask pi to state its instructions and run
`/skill:mp-sync-base`.

### Phase 5 — Guard hooks (`extensions/guard-hooks.ts`)

One extension, wrapping the existing scripts in
[`mpx-claude-code/hooks/`](file:///C:/_MP_projects/mpx-claude-code/hooks) via
`child_process.spawn` (`node <script>`), feeding each the same stdin JSON contract Claude Code
sends and translating the response. Event mapping:

| Claude Code hook | Script | pi event | Notes |
| --- | --- | --- | --- |
| PreToolUse (Bash) | `enforce-pkg-mgr.js`, `pre-commit-gate.js`, `dangerous-command-guard.js`, `fallow-gate.js` | `tool_call` (filter bash) | Return `{block: true, reason}` on script block verdict |
| PostToolUse (Edit\|Write) | `format-lint-file.js` | `tool_result` (edit/write) | Fire-and-forget |
| PostToolUse (Bash) | `post-bash-context.js` | `tool_result` (bash) | Script emits extra context; append it to the tool result (the `tool_result` handler can modify) |
| SessionStart | `machine-paths.js` | `session_start` | May be redundant if `AGENTS.md` covers `MPX_*`; keep for parity |
| SessionStart (compact) — Codex-only `compact-context.js` | `~/.codex/hooks/compact-context.js` | `session_compact` | Re-injects project context after compaction |
| Stop | `notify-flash-beep.ps1` | end-of-turn event (verify exact name — likely `agent_end`) | Spawn `powershell.exe -File` |

The scripts' stdin schema is Claude Code's hook payload — check each script's `shared.js` reader
and construct the minimal fields it actually uses; do not fake the full payload.

**Accept:** `npm install` with the wrong package manager is blocked with the script's own
message; a `git commit` without checks is blocked; editing a file triggers format+lint; ending a
turn flashes/beeps.

#### Findings (2026-07-31)

**Written:** [`extensions/guard-hooks.ts`](file:///C:/_MP_projects/mpx-pi/extensions/guard-hooks.ts)
— one file, 5 handlers, ~330 lines. Zero copies of the hook scripts: every script is spawned from
its absolute path under
[`mpx-claude-code/hooks/`](file:///C:/_MP_projects/mpx-claude-code/hooks) and none was edited.

**Real pi API used** (all signatures read off `dist/core/extensions/types.d.ts`, never guessed):

| Handler | Registration | Return shape actually used |
| --- | --- | --- |
| Guard quartet | `pi.on("tool_call", …)` | `ToolCallEventResult` = `{ block: true, reason }` (`types.d.ts:778-782`) |
| Format + lint | `pi.on("tool_result", …)` filtered to `edit`/`write` | `undefined` — spawn is fire-and-forget |
| Post-bash context | `pi.on("tool_result", …)` filtered to `bash` | `ToolResultEventResult` = `{ content: [...event.content, { type: "text", text }] }` (`types.d.ts:790-795`) |
| Machine paths | `pi.on("session_start", …)` | handler returns void; injection is `pi.sendMessage({ customType, content, display: false }, { deliverAs: "nextTurn" })` |
| Compact context | `pi.on("session_compact", …)` | same `sendMessage` path |
| Notify | `pi.on("agent_settled", …)` | void; `powershell.exe` spawned fire-and-forget |

Context injection is the one place the plan left open. `session_start` handlers cannot return
context, but `pi.sendMessage(…, { deliverAs: "nextTurn" })` pushes onto
`_pendingNextTurnMessages`, which `agent-session.js:876-881` splices in beside the next user
message — exactly Claude Code's `SessionStart` stdout semantics. Custom messages participate in
LLM context (`docs/extensions.md:1390`); `display: false` keeps them out of the TUI transcript.
Nuance: after a `threshold`/`overflow` compaction with `willRetry: true` the retry runs before the
next user prompt, so `compact-context.js` output lands one turn later than Claude Code's does.

**Per-script stdin payload** — only the fields each script's reader actually touches:

| Script | Payload sent | Fields the script reads |
| --- | --- | --- |
| `enforce-pkg-mgr.js` | `{tool_input:{command}, cwd}` | `tool_input.command`, `cwd` |
| `pre-commit-gate.js` | `{tool_input:{command}, cwd}` | `tool_input.command`, `cwd` |
| `dangerous-command-guard.js` | `{tool_input:{command}, cwd}` | `tool_input.command` only |
| `fallow-gate.js` | `{tool_input:{command}, cwd}` | `tool_input.command` only |
| `format-lint-file.js` | `{tool_input:{file_path}, cwd}` | `tool_input.file_path` (absolute; pi's `edit`/`write` take `path`, resolved against `ctx.cwd`) |
| `post-bash-context.js` | `{tool_input:{command}, tool_response:{stdout, stderr, exit_code}, cwd}` | all three of `tool_response` |
| `machine-paths.js` | `{cwd}` | nothing — it drains stdin and reads `MPX_*` env vars |
| `compact-context.js` | `{cwd}` | `cwd` |
| `notify-flash-beep.ps1` | no stdin | `-FlashCount` param (defaulted), `CLAUDE_NOTIFY_SILENT`, `~/.claude/notify-mute` |

**Two impedance mismatches, and how they are bridged.** pi's `bash` tool pipes the child's stdout
*and* stderr into one merged stream (`dist/core/tools/bash.js:82-83`), and it exposes no exit code
— on non-zero exit it throws `<output>\n\nCommand exited with code N`, which becomes the error
result's text (`bash.js:343-344`). So `post-bash-context.js` receives the merged text as **both**
`stdout` and `stderr` (it scans `stdout` for a PR URL and `stderr` for vulnerability warnings;
either can now appear in either), and `exit_code` is recovered with
`deriveBashExitCode()` — `0` when `isError` is false, else the parsed `N`, else `1`.

**Exit-code translation** (Claude Code's contract, replicated): exit `2` → block, stderr is the
reason; exit `0` → allow, stderr is *advisory* and goes to `ctx.ui.notify(…, "warning")` because
Claude Code shows PreToolUse stderr to the user and never to the model; any other exit code,
timeout, or spawn failure → infrastructure failure, resolved per the table below. Blocking reasons
are capped at 4,000 chars (last-N) — a deviation from Claude Code, which forwards stderr in full;
`pre-commit-gate.js` in a non-git directory dumps `git diff --cached`'s ~150-line usage text and
that would otherwise be pure context-window waste.

**Fail-open vs fail-closed, decided per script:**

| Script | Timeout | On its own failure | Why |
| --- | --- | --- | --- |
| `enforce-pkg-mgr.js` | 5 s | **fail-open** | Convention nudge; a wrong `npm` is recoverable, a dead harness is not |
| `pre-commit-gate.js` | 130 s | **fail-open** | Already fails open internally on git errors; also the only slow one — it shells out to `<pm> run check:all` with its own 120 s cap, so a 5 s outer timeout would silently disable the gate |
| `dangerous-command-guard.js` | 5 s | **FAIL-CLOSED** | Pure regex over the command string, no I/O — the only way it fails is a broken harness, and an unvetted `rm -rf /` beats a false block the user can bypass with `! <cmd>` |
| `fallow-gate.js` | 30 s | **fail-open** | Its own header says "Runtime errors fail open (exit 0)"; it already self-skips when the `fallow` binary is absent |
| `format-lint-file.js` | 50 s | fire-and-forget | — |
| `post-bash-context.js` | 10 s | fail-open (no context appended) | — |
| `machine-paths.js` / `compact-context.js` | 5 s | fail-open (no injection) | — |
| `notify-flash-beep.ps1` | 10 s | fire-and-forget | — |

Every timeout is copied **verbatim** from the `hooks` block of
[`mpx-claude-code/settings.json`](file:///C:/_MP_projects/mpx-claude-code/settings.json), so pi and
Claude Code cut the same script off at the same point. `process.execPath` is the node binary — the
fnm shim's `node` is not reliably on a child process's PATH — and `cwd` is `ctx.cwd`.

**`compact-context.js` verdict: WIRED, with an external dependency now owned by MPX Phase F.**
It is neither missing nor redundant — pi's compaction keeps a summary plus recent tokens and
re-states none of the package-manager / toolchain / framework facts this script derives from the
filesystem. Two historical caveats were recorded rather than fixed because the brief forbade
editing hook scripts:
1. It lives at `C:\Users\snapy\.codex\hooks\compact-context.js`, **outside** the canonical source.
   MPX Phase F must move it into a canonical package before Phase J retires `~/.codex`. The
   extension guards the path with `existsSync` and silently skips when
   it is gone, so retiring `~/.codex` degrades gracefully instead of erroring.
2. Its trailing convention block is Claude-flavoured and one line is now wrong: *"PRs auto-created
   as draft (hook)"* contradicts the PR-conventions rule (PRs normal by default) and depends on
   `gh-transform.js`, which open question 5 may delete. Fix it when it moves.

**Verification — headless, no model needed.**

1. **Scripts direct.** Each guard run by hand with a crafted payload against a throwaway
   `pnpm-lock.yaml` fixture: `npm install` → exit 2, `This project uses pnpm (detected from
   lockfile). Use 'pnpm' instead of 'npm'.`; `rm -rf /` → exit 2, `Blocked: broad recursive
   deletion is not allowed for AI agents.`; `git commit -m 'feat: x'` against a fixture whose
   `typecheck` script exits 1 → exit 2, `Pre-commit typecheck failed.`; `echo hello` → all four
   exit 0. `fallow-gate.js` self-skips here (`fallow binary not found`), which is its documented
   fail-open path.
2. **Extension handlers.** A throwaway `node --experimental-strip-types` harness in the scratchpad
   mocked `pi.on` / `pi.sendMessage` / `ctx`, called the default export, and drove every handler:
   **21/21 PASS.** Covered: the four real-script verdicts above through `evaluateBashGuards`; the
   `cat` tool-redirect advisory arriving as an advisory and not a block; fail-closed proven by
   faking a `dangerous-command-guard` spawn error (blocks) and fail-open by faking a timeout in
   each of the other three (advisory only); first-block-wins ordering; `tool_call` returning
   `{block:true, reason:/Use 'pnpm' instead of 'npm'/}` and ignoring non-bash tools; `tool_result`
   appending `PR created: https://…/pull/7` to `event.content` for a real `gh pr create` output and
   returning `undefined` for a plain command; `write` and `agent_settled` returning in <1 s
   (fire-and-forget proven); `session_start` queueing the real `Machine roots (from MPX_* env
   vars…)` text and `session_compact` queueing `This project uses pnpm…`.
   The extension is structured for this: `evaluateBashGuards`, `collectPostBashContext`,
   `deriveBashExitCode`, `extractAdditionalContext` and `BASH_GUARD_SCRIPTS` are named exports with
   an injectable `HookScriptRunner`, and `export default function (pi)` is thin wiring.
3. **Loader.** `pi --verbose -p "hi"` from this repo emits **no** extension diagnostic — only the
   expected Google 429 (still no `openai-codex` credentials). Proven to be a real signal and not
   silence-by-omission: dropping a deliberately broken `extensions/_probe.ts` made pi print
   `Error: Failed to load extension "…\_probe.ts": … ParseError: Missing semicolon.` and
   `Hint: Start without extensions using "pi -ne".` The probe was deleted; extensions **do** load
   in `-p` print mode.

**Accept: 3 of 4 verified headlessly.** Wrong-package-manager block, `git commit` block, and
format+lint dispatch are all proven. The flash/beep spawn is proven to fire and not block the
handler; that it actually flashes the Windows Terminal taskbar entry needs a real turn and is
pending the human `/login`.

**No deviation from the Phase 5 mapping table** beyond the `agent_settled` correction already
recorded in open question 1, and the reason-length cap noted above.

### Phase 6 — Subagents (`agents/`)

- Base: the official example ([examples/extensions/subagent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent))
  or `tintinweb/pi-subagents` — pick in Phase 1 based on which handles parallel + widget better
  hands-on.
- Generate pi agent `.md` files from
  [`mpx-claude-code/agents/`](file:///C:/_MP_projects/mpx-claude-code/agents) frontmatter
  (name/description/tools). **Source of truth stays `mpx-claude-code/agents/`** — the Codex
  `.toml` copies in `~/.codex/agents/` are the drifted artifact this migration deletes.
- Model mapping is an open decision (source pins are opus/sonnet/haiku): proposed default —
  orchestration/implementation agents → the main codex model at high thinking; reviewers →
  main model at medium; exploration/cheap agents (`mp-checker`, `mp-git-committer`,
  `mp-context7-docs-fetcher`) → the cheapest available codex-subscription model. Record the
  final mapping here.
- Per-agent thinking-level frontmatter does not exist in the example — patch `agents.ts` (a
  ~day) only if the mapping above proves insufficient.

**Accept:** a named agent spawns on its mapped model, runs in parallel (2+ concurrent), and its
result returns to the main session.

#### Findings (2026-07-31)

**Vendored:** [`extensions/subagents/`](file:///C:/_MP_projects/mpx-pi/extensions/subagents) —
`@tintinweb/pi-subagents` **v0.14.3** at upstream commit
**`8976c63f9857fb308926dd1d7369c2b7e059ffdc`** (2026-07-31, `feat: add opt-in nested subagent
delegation (#164)`), MIT © 2026 tintinweb. `LICENSE` copied verbatim; provenance, the edit list
and the re-sync recipe are in
[`extensions/subagents/VENDORED.md`](file:///C:/_MP_projects/mpx-pi/extensions/subagents/VENDORED.md).
Forked rather than `pi install`ed per open question 2, so neither an upstream nor a pi release can
change subagent behaviour silently, and Phase 7 item 11 can add the model/thinking columns in place.

**Edits to upstream — three, none of them to TypeScript logic:**

1. **Layout.** Upstream `src/*` (28 `.ts` files + `ui/`) vendored **flat** into
   `extensions/subagents/`, so pi's `extensions/*/index.ts` discovery rule picks it up. Every
   intra-package import is relative and survived the move untouched; nothing in `src/` referenced
   a path above itself (`grep -rn 'from "\.\./\.\./' src/` → empty).
2. **`package.json`** reduced to what pi reads plus the two runtime deps; `pi.extensions` points at
   `./index.ts` instead of `./src/index.ts`.
3. **Provenance header** prepended to `index.ts`. It is the *only* diff in any `.ts` file, so
   re-syncing stays a clean `diff -r`.

**No agent-path edit was needed.** `custom-agents.ts:29` already reads
`join(getAgentDir(), "agents")` → `~/.pi/agent/agents/`, which Phase 2 symlinked to this repo's
`agents/`. It additionally scans `<cwd>/.pi/agents/` and `<cwd>/.agents/agents/` (project
overrides), and project beats global on a name clash.

**Dependency split — the one real gotcha.** pi's extension loader aliases
`@earendil-works/*` and `@sinclair/typebox` for every extension it loads
(`dist/core/extensions/loader.js` → `getAliases()`, jiti `alias` in Node mode /
`virtualModules` in the Bun binary), so those resolve with no `node_modules` anywhere. **`croner`
and `nanoid` are not aliased** and resolve by ordinary upward lookup from the importing file, so
they must be installed next to the vendored source:

```bash
cd C:/_MP_projects/mpx-pi/extensions/subagents && npm install   # after a fresh clone
```

`node_modules/` was already gitignored. **No `settings.json` change:** the fork lives inside the
symlinked `extensions/` directory, so it auto-discovers; `extensions: []` stays empty and
`packages` is never used — which is exactly the "extensions gains entries only if an extension has
to live outside the repo" prediction from Phase 3.

**Collision check — clear.** `grep -rl "loadCustomAgents\|subagent" dist/core/` over the pi package
returns nothing, and `dist/core/tools/` holds only the seven built-ins — pi core registers no agent
feature. The official example lives at `examples/extensions/subagent/` **inside the npm package**,
which is not a discovery root, and nothing lists it in `extensions`/`packages`.
`~/.pi/agent/extensions/` contains exactly `guard-hooks.ts` and `subagents/`, and `guard-hooks.ts`
registers no tools. The loader probe below confirms one registration of `Agent`,
`get_subagent_result`, `steer_subagent` and `/agents`.

**Generator:**
[`scripts/generate-agents.mjs`](file:///C:/_MP_projects/mpx-pi/scripts/generate-agents.mjs) —
plain Node, zero dependencies. It reads every `mpx-claude-code/agents/*.md`, maps the frontmatter,
and writes `agents/<name>.md` with the **body byte-identical** to the source. `--check` re-renders
and diffs without writing, exiting 1 on any drift — the idempotence gate. It is the only supported
way to refresh `agents/`; a hand-edit is overwritten on the next run, which the generated header
comment says in the file itself.

Fields the target schema actually parses were read off the fork
(`extensions/subagents/custom-agents.ts:56-91`), not assumed: `display_name`, `description`,
`tools`, `disallowed_tools`, `extensions`, `exclude_extensions`, `skills`, `model`, `thinking`,
`max_turns`, `persist_session`, `output_transcript`, `session_dir`, `allowed_subagents`,
`prompt_mode`, `inherit_context`, `run_in_background`, `isolated`, `memory`, `isolation`,
`enabled`; the body becomes the system prompt. **The agent name comes from the filename** — a
`name:` key is ignored, so none is written. Parsing is pi's own `parseFrontmatter`, i.e. a real
YAML parser (`dist/utils/frontmatter.js:1` → `import { parse } from "yaml"`), so descriptions are
emitted as JSON-quoted scalars and the "generated" header rides as YAML `#` comments inside the
frontmatter rather than polluting the system prompt.

**Model mapping — PROVISIONAL until `/login` confirms the subscription grants these models.**
Written as `provider/modelId` so the fork's resolver (`model-resolver.ts:33-39`) takes the
exact-match path instead of fuzzy-matching. Two axes, not one: the Claude **model** pin picks the
codex model, the Claude **effort** pin picks the thinking level. That is a deliberate refinement of
the flat proposal in the phase body — it preserves the July 2026 benchmark decisions recorded in
[`mpx-claude-code/docs/SUBAGENTS.md`](file:///C:/_MP_projects/mpx-claude-code/docs/SUBAGENTS.md)
(reviewers at `medium`, `Explore` at `low`, `mp-executor` at `low`) instead of flattening every
opus agent to `high`.

| Claude pin | Codex model | Thinking | Agents |
| --- | --- | --- | --- |
| `opus` + `effort: high` | `openai-codex/gpt-5.6-sol` | `high` | `mp-check-fixer`, `mp-chrome-devtools-tester`, `mp-ci-fixer`, `mp-issue-analyzer` |
| `opus` + `effort: medium` | `openai-codex/gpt-5.6-sol` | `medium` | `mp-tdd-executor`, `mp-ui-variant-generator` |
| `opus` + `effort: low` | `openai-codex/gpt-5.6-sol` | `low` | `mp-executor` |
| `sonnet` + `effort: medium` | `openai-codex/gpt-5.5` | `medium` | the 7 `mp-reviewer-*`, `mp-scanner-architecture` |
| `sonnet` + `effort: low` | `openai-codex/gpt-5.5` | `low` | `Explore`, `mp-issue-finder`, `mp-pr-manager`, `mp-unresolved-issue-tracker` |
| `haiku` (declares no effort) | `openai-codex/gpt-5.4-mini` | `low` | `mp-checker`, `mp-context7-docs-fetcher`, `mp-git-committer` |

7 agents on `gpt-5.6-sol`, 12 on `gpt-5.5`, 3 on `gpt-5.4-mini` — **22 generated**, one per source
file. Haiku supports no effort at all on the Claude side; `gpt-5.4-mini` does, and `low` is the
level its Claude counterparts were benchmarked as sufficient at.

**Tool mapping — restriction is fully supported**, contrary to the phase body's hedge. The fork's
`parseToolsField` partitions `tools:` into pi's built-ins (derived at runtime from
`createCodingTools`/`createReadOnlyTools`, not hardcoded) plus `ext:` selectors, and honours
`disallowed_tools`. Mapping: `Read→read`, `Bash→bash`, `Edit→edit`, `Write→write`, `Grep→grep`,
`Glob→find, ls` (pi splits Claude's `Glob` into pattern search and directory listing). Claude's
`disallowedTools` subtracts from the full set, so those agents are emitted as the complementary
allowlist — which is what SUBAGENTS.md says the Claude semantics already are.

**Degraded agents.** Bodies are copied verbatim and are **not** rewritten, so an agent whose body
names a tool pi lacks simply cannot call it.

| Agent | Degradation | Severity |
| --- | --- | --- |
| `mp-context7-docs-fetcher` | Both MCP tools dropped — pi has no MCP client. `tools` collapses to `read`, and the body's `mcp__plugin_context7_context7__*` call examples are dead. | **non-functional** until `pi-mcp-adapter` or `@upstash/context7-pi` lands (both on the Phase 1 shortlist) |
| `mp-chrome-devtools-tester` | Its entire purpose is the `mcp__chrome-devtools__*` toolset; nothing to map. | **non-functional**, same fix |
| `mp-check-fixer`, `mp-ci-fixer` | `Agent` dropped. The fork *does* ship an `Agent` tool, but nested delegation is opt-in via `allowed_subagents` and default-off — deliberately left off pending a privilege review (upstream calls the allowlist "a privilege boundary"). Both will do the work inline and pollute their own context instead of failing. | partial |
| `mp-issue-analyzer` | `WebFetch` dropped, no pi equivalent. It keeps `bash`, so `gh`/`curl` covers most of it. | partial |
| `Explore` | Loses only Claude-only denials (`Agent`, `Artifact`, `ExitPlanMode`, `NotebookEdit`); the read-only guarantee survives as `read, bash, grep, find, ls`. Note it also **overrides the fork's built-in `Explore`** in `DEFAULT_AGENTS`, mirroring the Claude-side override. | cosmetic |

**Not degraded, contrary to expectation:** the 11 agents whose bodies `cat
$HOME/.claude/skills/shared/REVIEWER_PROTOCOL.md`, `.../EXECUTOR_CONTRACT.md`,
`$HOME/.claude/scripts/detect-base-branch.js` and friends all still resolve — `~/.claude/skills`
and `~/.claude/scripts` are themselves symlinks into `mpx-claude-code`, and Claude Code stays
installed by the migration's own premise. The only friction is cosmetic: `SYSTEM.md` tells the
model to prefer `read` over `cat`.

**Verification — headless.**

1. **Extension loads.** `pi --verbose -p "hi"` from this repo prints no extension diagnostic before
   the expected Google 429 — the signal Phase 5 proved is real. Positive confirmation came from
   driving pi's own loader in-process (`node` importing
   `dist/core/extensions/loader.js` → `discoverAndLoadExtensions([], cwd, agentDir)`):
   `errors: []`, and `.../extensions/subagents/index.ts` registers tools
   **`Agent, get_subagent_result, steer_subagent`**, command **`agents`**, handlers
   `session_start, session_before_switch, session_shutdown, tool_execution_start`. `croner` and
   `nanoid` therefore resolved through the symlinked path.
2. **Every generated file parses against the real parser.** A throwaway
   `extensions/_probe-agents.ts` imported `./subagents/custom-agents.js` and called
   `loadCustomAgents()` inside a live `pi -p` run — pi's actual jiti loader, not a replica.
   `PROBE_AGENT_COUNT=22`, and each row carried the expected `model`, `thinking`, built-in tool
   list and a non-empty system prompt. The probe was deleted afterwards.
3. **Idempotent.** `node scripts/generate-agents.mjs` twice, then
   `node scripts/generate-agents.mjs --check` → `check: clean — output is up to date`, exit 0.
4. **Bodies unchanged.** All 22 generated bodies compare byte-identical to their source bodies.
   All 22 files are BOM-free.

**Accept: 1 of 3 verified.** Definitions load with the mapped model and thinking level. That an
agent actually *spawns* on `gpt-5.6-sol`, runs 2+ concurrent, and returns its result needs a live
provider and is **pending the human `/login`** — as is confirming the subscription grants
`gpt-5.6-sol`, `gpt-5.5` and `gpt-5.4-mini` at all. If it does not, edit `MODEL_BY_CLAUDE_PIN` in
the generator and re-run; no `agents/*.md` is ever hand-edited.

### Phase 7 — Statusline (`extensions/footer.ts` + `subagent-panel.ts`)

Port order (value ÷ effort), reusing the gauges, colors, and parsing logic in
[`mpx-claude-code/scripts/lib/statusline-ansi.mts`](file:///C:/_MP_projects/mpx-claude-code/scripts/lib/statusline-ansi.mts),
[`mpx-claude-code/scripts/lib/compaction.mts`](file:///C:/_MP_projects/mpx-claude-code/scripts/lib/compaction.mts),
[`mpx-claude-code/scripts/status-line.mts`](file:///C:/_MP_projects/mpx-claude-code/scripts/status-line.mts),
[`mpx-claude-code/scripts/subagent-status-line.mts`](file:///C:/_MP_projects/mpx-claude-code/scripts/subagent-status-line.mts):

| # | Feature | Source of data in pi | Port notes |
| --- | --- | --- | --- |
| 1 | Model + thinking gauge `◆◆◇◇◇◇` | `ctx.model`, settings thinking level | pi has 7 levels (`off…max`), represented as an empty gauge plus 1–6 filled slots |
| 2 | Context bar toward the auto-compact trigger + % | `ctx.getContextUsage()`, trigger = `contextWindow − reserveTokens` (documented, no reverse-engineering) | Reuse 50/70/90% escalation colors |
| 3 | Cost + token counts | core footer data | — |
| 4 | Codex quota bars 5h/weekly + reset | `pi-usage` / `pi-codex-status` technique: ChatGPT backend call with stored OAuth token, or `x-codex-primary/secondary-used-percent` headers via `after_provider_response` | Replaces the Claude `rate_limits` block |
| 5 | Git branch + `≡/↑/↓` + `+n !n ?n ~n` + fetch age | shell out, port the porcelain-v2 parser | Same 98 ms budget considerations; pi footer renders in-process so cache accordingly |
| 6 | Location row: project/worktree split, VS Code glyph, OSC-8 `file:` links, `.url` shim for `vscode:` | port from `status-line.mts` | OSC-8 passthrough confirmed in `pi-tui` docs; verify in Phase 1 |
| 7 | Compaction history rows | `CompactionEntry` nodes in the session tree, available in-process | No byte-offset cache needed — delete that machinery, keep the row renderer |
| 8 | Session name/id → transcript JSONL link | session manager + OSC-8 | trivial |
| 9 | MR/PR + CI block | port `status-line-mr-refresh.sh` + `$TMPDIR` cache pattern | ~day; unchanged `gh`/`glab` calls |
| 10 | Dev-server port probes + pencil link | port probe (localhost + TLS-detect) into a timer in the extension | reuse `statusline-projects.json` |
| 11 | Subagent panel: per-agent status/model/thinking/context %/elapsed + markers + `Σ` tally | fork the pi-subagents widget renderer; tally via `agent_end` events | Their widget lacks model/thinking columns — add; the `Σ` tally is *easier* than Claude Code's 30 s-eviction TSV hack |

**Accept:** side-by-side with the Claude Code bar, the pi footer shows equivalent rows for this
repo; unit tests are not required, but keep pure helpers importable so vitest can cover the
ports later.

#### Findings (2026-07-31) — rows 1-8

**Delivered:** [`extensions/footer.ts`](file:///C:/_MP_projects/mpx-pi/extensions/footer.ts), rows
1-8 of the table above, installed through `ctx.ui.setFooter()`. Rows 9-11 are deferred to part 2.

**Import, not copy — verified.** pi's jiti loader resolves **absolute `.mts` paths into
mpx-claude-code** (two live probe extensions, `PROBE_IMPORT_OK` / `PROBE_STATUSLINE_OK`, importMs=1),
so `footer.ts` imports the parsers and formatters straight from the Claude sources and there is one
source of truth: `parsePorcelainV2`, `parseWorktreePaths`, `resolveProjectLocation`, `toFileUrl`,
`buildBranchUrl`, `buildCompareUrl`, `parseDefaultBranch`, `humanAge`, `timeUntil`, `INDENT_GUARD`
from `scripts/status-line.mts`; `COMPACTION_ROWS`, `formatClock`, `formatTokensK` from
`scripts/lib/compaction.mts`; `RESET`, `isNonNegativeInt` from `scripts/lib/statusline-ansi.mts`.
**No `extensions/lib/` copies exist.** What *is* re-expressed in `footer.ts` is only the
colour-bearing builders (`buildGitSigns`, `buildGitDirt`, the bar, the usage/quota rows): the mpx
versions bake a `loadPalette()` Windows-Terminal palette in at module scope, while pi must colour
from its own `theme` — `resolveFooterPalette(theme)` maps pi's `ThemeColor` slots and falls back to
xterm-256 for the two hues pi has no slot for (context-orange 208, local-branch sand 180).
`theme.getFgAnsi()` **throws** on an unknown colour (`theme.js:281-286`), so every lookup goes
through `themeColor(theme, color, fallback)`.

**Render cost.** Claude Code re-ran a child process per tick; pi calls `render(width)` in-process.
So every shell-out, file read and network call lives in a background refresher (`agent_settled`,
`onBranchChange`, and an unref'd 15 s interval) and `render()` is pure formatting over a snapshot.
The session digest (cost, token totals, compaction list) is recomputed only when `getLeafId()`
moves.

**Quota (row 4) — two sources, both guarded.** Primary is free: `after_provider_response` →
`parseCodexQuotaHeaders(event.headers)` reading `x-codex-{primary,secondary}-{used-percent,
window-minutes,reset-at,reset-after-seconds}` + `x-codex-plan-type`. Cold start is a background
`GET https://chatgpt.com/backend-api/wham/usage` with the bearer from
`ctx.modelRegistry.getApiKeyForProvider("openai-codex")` and the account id decoded from the JWT
claim `https://api.openai.com/auth`.`chatgpt_account_id` — 5-minute TTL, 5 s timeout, 3-failure
circuit breaker. `pi-codex-status` was read as reference only, nothing vendored; its
`authStorage` path does not exist in v0.83.0. **Pre-login the row hides entirely** (verified).
Events used: `after_provider_response`, `session_compact`, `agent_settled`, `model_select`,
`thinking_level_select`, `session_start`. **There is no `extension_load` event** — `session_start`
is the earliest point a `ctx` exists, so the footer installs there behind a `footerInstalled` guard.

**Deviations recorded:**

- **Compaction rows (7)** state the trigger point only. pi's `CompactionEntry` carries
  `tokensBefore` and no `tokensAfter`, so the Claude row's `227k → 11k` cannot be reproduced.
  The trigger word comes from an in-process `Map<entryId, reason>` fed by `session_compact`; a
  **resumed** session renders older compactions as `compact` because pi never persists the reason.
- **CZK conversion skipped** — the mpx rate logic is a detached child plus a Claude-specific
  `$TMPDIR` cache; it does not port trivially. Cost renders in USD.
- **Deferred polish:** the VS Code `.url` shim and the terminal-duplication glyphs of row 6, and
  rows 9-11 (MR/CI block, dev-server port probes, subagent-panel columns). Rows 9-11 append to
  `FOOTER_ROW_BUILDERS`; the palette already reserves a `mr` slot.

**Verified headless — 101/101 assertions, 0 failures.** A throwaway harness plus a temporary probe
extension ran *inside a real `pi --verbose -p "hi"`*, so the module graph was resolved by pi's own
loader rather than a replica; both were deleted afterwards. Covered: all 7 gauge levels (distinct,
6 cells each, monotonic), the context escalation colours at 40/60/80/95 % of the trigger, the
porcelain-v2 parser against 6 fixtures (clean, dirty+diverged, local-only, remote-deleted, ahead-,
behind-only), quota header/API/JWT parsing, the quota row hidden with no data, compaction rows from
fake `CompactionEntry` nodes, the branch-state row hidden outside a repo, the `tokens: null`
post-compaction degradation, and a theme whose every colour lookup throws. Loader probe clean —
no extension diagnostics before the expected Google 429. Sample render (ANSI, escaped, and plain):
`…/scratchpad/footer-sample-render.txt`.

```text
phase 7 footer port · #a1b2c3d4
gpt-5.6-sol · ◆◆◆◇◇◇
mpx-pi ·  martas/footer
⠀   ↑3↓1 · +2 · !2 · ?1 · ~1 · 2h ago
153.4k (56%) ██████░░░░ · ↑42.0k ↓2.0k · $0.412
⠀ ├─ 1 earlier
⠀ ├─ threshold · 240k · 12:20
⠀ ├─ manual    · 251k · 13:30
⠀ └─ overflow  · 255k · 14:40
5h ███░░░░░ 42% 1h 21m · 7d ░░░░░░░░ 12% 1157d 9h
```

(Mock data. The branch glyph is U+E725 and needs the Nerd Font fallback, so it is blank above;
the absurd weekly countdown is the fixture's far-future reset epoch, not a formatting bug.)

**Still pending the human `/login`:** the real-session look, OSC-8 click-through in Windows
Terminal, and any live quota numbers (row 4 has never rendered with real data).

#### Findings (2026-07-31) — rows 9-11

**Delivered:** rows 9, 10 and 11 of the table above, completing Phase 7's build.
[`extensions/footer.ts`](file:///C:/_MP_projects/mpx-pi/extensions/footer.ts) is now 1945 lines;
the vendored subagents fork gained two marked edits.

**Row 9 — MR/PR + CI.** Rides on the location row, exactly as the Claude bar composes it
(`buildLocationLine` = name, branch, ports, MR block). Renders
`#42 approved · ci ok · 3 comments · 12m ago`: the reference OSC-8-linked to the PR, the review
state bound to it with a space, CI linked to `buildCiUrl()`, and a muted age note past 600 s.
`gh pr list -R <project> --head <branch> --state open --limit 1 --json …` and the same glab
GraphQL query as the shell script, both capped at 10 s. The `MrFields` field contract and
`buildCiUrl` are **imported** from `status-line.mts`, so the two bars agree on what a field means;
only the jq reductions are re-expressed (`rollupCheckState`, `normalizeGitlabPipelineState`,
`reduceGithubPullRequest`, `reduceGitlabMergeRequest`). TTL 90 s / attempt floor 30 s / stale note
600 s are the script's constants verbatim — but **no `$TMPDIR` cache file, no detached child, no
atomic write**: the refresher runs in-process off `agent_settled` and the 15 s git timer, and the
answer is a field on the snapshot. Degradation is silent at every step: no remote, an unparseable
remote, a non-GitHub/GitLab host, a missing or unauthenticated CLI, a non-zero exit, or no open
PR all leave `mergeRequest` undefined and the block absent. A failed refresh never blanks a
previously good answer; a branch change drops it immediately.

**Row 10 — dev-server ports.** `:8100 · :8101 · ✏` on the location row, green while the port
answers and dim while it does not, each linked to `<scheme>://localhost:<port>`. The scheme comes
from the probe: TCP connect to `localhost` (not 127.0.0.1 — happy-eyeballs finds an IPv6-only
server), then a TLS handshake over the same socket; completed = https, rejected or ignored = http.
400 ms timeout, all ports probed in parallel on the same timer as row 9, never in `render()`.
Ports are declared in
[`statusline-projects.json`](file:///C:/_MP_projects/mpx-claude-code/statusline-projects.json)
— **the Claude bar's own file, read by absolute path**, one list edited in one place, and the
pencil (U+F03EB) opens exactly that file. A project with no entry gets a dim `✏ ports` hint
instead; outside a project the pencil is absent too. `probePort` is private in `status-line.mts`,
so the probe itself is re-expressed rather than imported — editing the Claude repo to export it
would have dragged its README-sync rule and test suite into this commit.

**Row 11 — route (b), minimal fork edit + a footer-side ledger.** Route (a), a separate
`extensions/subagent-panel.ts`, was **ruled out by inspection**: the fork keeps its `AgentManager`
and `AgentWidget` private to the default export, and its whole cross-extension surface is
`subagents:rpc:ping|spawn|stop` — no outside extension can read live agent state, so the live
model/thinking columns are unreachable from another file. Two edits, each carrying a
`VENDOR EDIT (mpx-pi, Phase 7 row 11)` comment so `grep -rn "VENDOR EDIT"` lists the diff surface,
both appended to [`VENDORED.md`](file:///C:/_MP_projects/mpx-pi/extensions/subagents/VENDORED.md):

| File | Edit | Why |
| --- | --- | --- |
| `ui/agent-widget.ts` | new exported `buildModelThinkingCells()`, called from `renderFinishedLine()` and the running-agent header; finished stats now go through `fgPreservingNestedStyles` | upstream shows model/thinking only in the spawn-time tags, so the panel could not say which agent ran which model. `thinkingGauge` is imported from `../../footer.js` — panel and main bar share one gauge definition |
| `index.ts` | `buildEventData()` also emits `model` and `thinking` from `record.invocation` | the shared event bus is the footer's only view of a finished agent. The actual resolved model is emitted for both inherited and pinned runs; thinking remains absent when unspecified |

The **Σ tally needs no fork state at all**: `pi.events` is one shared bus
(`loader.js:401`, `types.d.ts:1015`), the fork already publishes `subagents:completed` /
`subagents:failed`, and the footer accumulates them into an in-memory array. **The predicted
design win holds** — Claude Code evicts a terminal task from the status-line payload 30 s after it
ends and therefore needs a per-session TSV mirror; pi's extension host outlives every agent, so
there is no state file, no eviction race and no directory to garbage-collect. The row reuses
`lib/subagent-history.mts` outright (`countLabel`, `groupMembers`, `selectDetailRows`,
`formatDuration`, `formatTokens`, `AGENT_TYPE_ROWS`, `AGENT_DETAIL_ROWS`, `COMPLETED`), so the
`2×Explore` idiom, the failed-agent-first ordering and the 5-row cap are one definition. Split of
duty mirrors the Claude one exactly: the fork's above-editor widget owns the **live** view,
row 11 owns the **history**; nothing renders in both.

**Deviations recorded:**

- **Comment count reads `3 comments`, not 💬3** — the speech-bubble emoji font-falls back to
  Segoe UI Emoji and draws double-width into one reserved cell.
- **Model groups keep their real spelling** (`3×haiku`, not `3×Haiku`). The Claude bar
  capitalises because it groups by tier *name*; pi groups by the id the model is addressed as.
- **Rule-violation markers deferred** — the fork has no tier-policy signal, so every
  `drifted` flag passed to the shared helpers is `false`. Nothing to mark until pi grows an
  equivalent constraint.
- **CZK stays deferred** (unchanged from part 1), as do the VS Code `.url` shim and the
  terminal-duplication glyphs of row 6.

**Verified headless — 206/206 assertions, 0 failures** (rows 1-8 regression included: the
part-1 suite grew from 101 to 206 in the same file, all still passing). New coverage: 4 remote-URL
forms plus 2 rejections; provider detection; 5 check-rollup reductions and 3 GitLab pipeline
normalisations; GitHub and GitLab payload reductions including their empty forms; all 8 review-state
precedence branches; the MR block's reference/state/CI/comments/age composition, its two OSC-8
targets, and its absence with no data, no iid, and no CI; the ports config read against the **real
shared file** plus unknown-project, empty-name and missing-file paths; port segments green/dim, both
schemes in the link, the pencil target, the `✏ ports` hint, and the row absent outside a project;
the ledger built from 5 fake lifecycle events (model fallback to the session model, absent thinking,
missing tokens, a failed agent), the Σ header's counts/models/aggregate tokens/type groups, the
detail rows' glyphs, alignment and gauges, the 5-row cap with `+4 more` keeping the heaviest, and
the row absent with no agents; and the fork helper's 4 cell combinations. Loader probe clean — no
extension diagnostics before the expected Google 429. Full sample render (ANSI, escaped, plain, and
the same bar with rows 9-11 absent): `…/scratchpad/footer-sample-render.txt`.

```text
phase 7 footer port · #a1b2c3d4
gpt-5.6-sol · ◆◆◆◇◇◇
mpx-pi ·  martas/footer · :8100 · :8101 · ✏ · #42 approved · ci ok · 3 comments · 12m ago
⠀   ↑3↓1 · +2 · !2 · ?1 · ~1 · 2h ago
153.4k (56%) ██████░░░░ · ↑42.0k ↓2.0k · $0.412
⠀ ├─ 1 earlier
⠀ ├─ threshold · 240k · 12:20
⠀ ├─ manual    · 251k · 13:30
⠀ └─ overflow  · 255k · 14:40
5h ███░░░░░ 42% 1h 21m · 7d ░░░░░░░░ 12% 1157d 9h
Σ 5 agents · 3×haiku 87.3k 1×gpt-5.6-sol 98.0k 1×sonnet 0 · 3×Explore Plan general-purpose
⠀ × general-purpose sonnet                9s       0
⠀ ✓ Explore         haiku       ◆◆◇◇◇◇    42s   31.0k
⠀ ✓ Explore         haiku       ◆◆◇◇◇◇  1m01s   52.0k
⠀ ✓ Plan            gpt-5.6-sol ◆◆◆◆◇◇  3m00s   98.0k
⠀ ✓ Explore         haiku                12s    4.3k
```

(Mock data. The branch glyph U+E725 and the pencil U+F03EB need the Nerd Font fallback, so they
render blank/substituted above.)

**Still pending the human `/login`:** live `gh`/`glab` output, a real dev server answering a probe,
and the panel columns with real agents — plus everything part 1 left pending.

### Phase 8 — Retire `~/.codex` mirror (transferred)

This remaining action is transferred to MPX Phases F/I/J. The MPX import must relocate or retire
`~/.codex/hooks/`, `~/.codex/agents/`, and Codex-only hooks without creating another independent
Pi source. Keep the Codex desktop app only if an MPX cutover inventory proves it still owns a
required capability.

**Historical acceptance target:** `~/.codex` contains only runtime data the desktop app needs, no
hand-maintained config that can drift.

## Out of scope

- Claude models in pi (see Key decisions).
- Porting the pipeline skills (`mp-execute`, `mp-ship`, reviewers fan-out) — evaluate only
  after the base harness has been in daily use.
- Sandboxing was out of scope for this standalone Pi bootstrap. It is now the optional Docker
  executor POC in MPX Phase F2 and is not governed by this journal.

## Open questions

1. Exact end-of-turn event name for the notify hook (Phase 5).
   **ANSWERED (2026-07-31): `agent_settled`** — "fired after an agent run has fully settled and
   no automatic retry, compaction, or queued continuation will run"
   (`dist/core/extensions/types.d.ts:544-547`; last node of the lifecycle diagram at
   `docs/extensions.md:311-312`). `agent_end` is **not** the right one: it fires when the agent
   loop ends and can still be followed by an automatic retry, a threshold/overflow compaction, or
   a queued follow-up, so it would flash/beep several times per user turn. Payloads:
   `agent_settled` is `{ type }` only; `agent_end` is `{ type, messages: AgentMessage[] }`.
   Use `agent_settled` for `notify-flash-beep.ps1`, `agent_end`/`turn_end` for statistics.
2. Subagent base: official example vs `tintinweb/pi-subagents` (Phase 1 decides).
   **ANSWERED (2026-07-31): use `tintinweb/pi-subagents` as the base** (`pi install
   npm:@tintinweb/pi-subagents`, or fork its source). Both were compared without installing.
   The shipped `examples/extensions/subagent/` parses only `name`, `description`, `tools`,
   `model` and spawns each agent as a separate `pi` child process with streaming output.
   `pi-subagents` adds precisely the four things Phases 6-7 need: **`thinking` frontmatter**
   (off→max, which removes the "patch `agents.ts`, ~a day" risk in Phase 6), **real parallelism**
   (background agents, default concurrency 4 with auto-queue), a **persistent widget above the
   editor** already showing token counts, context-window %, tool-use counters and elapsed time
   (Phase 7 item 11 then only needs model/thinking columns added), plus `max_turns`,
   `allowed_subagents` for nested delegation, `isolation: worktree`, and mid-run steering.
   Keep the official example as the fallback reference if `pi-subagents` breaks on a pi upgrade.
3. Model mapping table for agents (Phase 6, record here).
   **ANSWERED (2026-07-31), provisionally.** Two axes, not one: the Claude **model** pin picks the
   codex model (`opus → openai-codex/gpt-5.6-sol`, `sonnet → openai-codex/gpt-5.5`,
   `haiku → openai-codex/gpt-5.4-mini`) and the Claude **effort** pin becomes the `thinking` level
   verbatim (`low`/`medium`/`high`; haiku declares none, so its three agents get `low`). Full
   per-agent table in the Phase 6 findings. This keeps the July 2026 benchmark decisions in
   `SUBAGENTS.md` — reviewers at `medium`, `Explore` and `mp-executor` at `low` — instead of
   flattening every opus agent to `high`. The mapping lives in `MODEL_BY_CLAUDE_PIN` /
   `THINKING_BY_EFFORT` in [`scripts/generate-agents.mjs`](file:///C:/_MP_projects/mpx-pi/scripts/generate-agents.mjs),
   never in the generated files. **Provisional** because `~/.pi/agent/auth.json` is still empty:
   the seven-model catalog is what pi *knows*, not what the ChatGPT subscription *grants*. First
   `/model` listing after `/login` either confirms it or costs one edit plus a regenerate.
4. Gauge mapping for 7 thinking levels in 6 slots (Phase 7).
   **ANSWERED (updated): an empty `off` gauge plus one whole diamond per enabled level.**

   | level | gauge | filled |
   | --- | --- | --- |
   | `off` | `◇◇◇◇◇◇` | 0 |
   | `minimal` | `◆◇◇◇◇◇` | 1 |
   | `low` | `◆◆◇◇◇◇` | 2 |
   | `medium` | `◆◆◆◇◇◇` | 3 |
   | `high` | `◆◆◆◆◇◇` | 4 |
   | `xhigh` | `◆◆◆◆◆◇` | 5 |
   | `max` | `◆◆◆◆◆◆` | 6 |

   Pi exposes `off` plus six increasing effort levels, so six slots represent the scale directly:
   `off` has no filled diamonds and each enabled level adds exactly one. This replaces the original
   five-slot compromise and its half-filled `xhigh` glyph. Implemented as the pure exported
   `thinkingGauge(level)` in
   [`extensions/footer.ts`](file:///C:/_MP_projects/mpx-pi/extensions/footer.ts); an unrecognised
   level falls back to the `<level>` spelling rather than a wrong gauge.
5. Whether `gh-transform.js` (auto-draft PRs) survives — it contradicts the PR-conventions
   rule (PRs normal by default).
