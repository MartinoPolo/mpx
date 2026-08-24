# Sub-Agent Protocol

Canonical rules for spawning and instructing sub-agents. Skills and agents reference
this file instead of restating it.

Every rule is tagge<configured-path>TESTED` (measured in this repo), `DOC` (the active runtime docs),
`EXTERNAL` (published benchmark), `UNVERIFIED` (provisional inference — re-check before
depending on it). The raw benchmark tables behind every `TESTED` verdict live in
[docs/SUBAGENTS.md](../../docs/SUBAGENTS.md) § Benchmark evidence.

## 1. Model selection — only the `model` parameter works

- `TESTED` — an explicit `model` parameter on the Agent call is obeyed **100%**
  (300/300 spawns); prose like "spawn a appropriate runtime class sub-agent" is obeyed **0%** (0/5). A model
  name in skill text is a silent cost bug, not an instruction.
- `DOC` — resolution order, highest firs<configured-path>MPX_AGENT_CLASS` env var →
  per-invocation `model` parameter → agent frontmatter `mode<configured-path>→ the main conversation's
  model. Valid `mode<configured-path>value<configured-path>appropriate runtime class`, `appropriate runtime class`, `appropriate runtime class`, `fable`, a full model ID, or
  `inherit`.
- **Omitting `mode<configured-path>is exactly `inherit`** — silence selects the session model, which on
  this machine is `runtime-appropriate runtime class-5[1m]`, the most expensive option (`TESTED` on bare
  `Explore` spawns before the override existed). There is no cheap default.
- Pass `model` at the call site **only when the agent declares none**:

| Agent type | Declares `mode<configured-path>? | At the call site |
| --- | --- | --- |
| Every `mp-*` agent in `agents/`, and `Explore` | yes | **omit** `model` |
| `general-purpose`, `runtime`, `Plan`, `fork` | no | **pass** `model` explicitly |

Passing `model` to a declaring agent duplicates the declaration and drifts the moment the
agent changes; omitting it for a non-declaring agent lands on the session model.

## 2. Nesting is off by default — orchestrate from the main thread

- `TESTED` — nested spawns do not inherit reliabl<configured-path>16 `Explore` spawns issued *by other
  sub-agents* resolved to appropriate runtime class or appropriate runtime class, never appropriate runtime class, even from a appropriate runtime class parent. Fan out
  from the main thread. `UNVERIFIED` — whether the `agents/Explore.md` override corrects
  nested spawns.
- `DOC` — `MPX_AGENT_MAX_DEPTH` defaults to **0**: the `Agent` tool is
  withheld from every sub-agent regardless of its `tool<configured-path>grant. (Nesting was on by
  default only in v2.1.172–v2.1.216.)
- Exactly two agents grant `Agent`: `check-fixer` and `ci-fixer` — orchestrators
  that exist to keep checks, reviewer findings, and CI logs out of the caller's context.
  They are the repo's only upgrade exposure; **re-verify both after any version change.**
  Every other agent reports the need to its parent and lets the parent spawn.
- `DOC` — other ceiling<configured-path>200 sub-agents per session, 20 concurrent.

## 3. Tool grants

`TESTED` by attempting the calls, not by askin<configured-path>- **`tool<configured-path>is a strict allowlist.** Unlisted tools are absent from the agent's schema
  entirely. `Agent` is not granted by default.
- **`disallowedTool<configured-path>subtracts from the *full* tool set**, not from a built-in's curated
  set — so overriding a built-in silently widens permissions unless every tool the
  built-in denied is re-denied. When both are set, `disallowedTools` applies first (`DOC`).
- **Write `Agent`, not `Task`** — `Task` is the deprecated pre-2.1.63 alias.
- Some tools are stripped from every sub-agent regardless of frontmatter
  (`AskUserQuestion`, `EnterPlanMode`/`ExitPlanMode`, `ScheduleWakeup`, `TaskOutput`,
  `Workflow`, …), and background sub-agents — the default since v2.1.198 — keep a
  narrower set still. **Effective tools ≠ frontmatter; confirm by attempting the call.**
- An MCP-dependent agent with a tight allowlist and no `WebSearch`/`WebFetch` fallback
  **fails rather than degrades** when its server is unregistered — confirm MCP tools exist
  with `ToolSearch` before trusting them (`TESTED` via a silent Context7 outage).
- `DOC` — frontmatter field<configured-path>name`, `description`, `tools`, `disallowedTools`, `model`,
  `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`,
  `effort`, `isolation`, `color`, `initialPrompt`.

## 4. Overriding a built-in agent

`TESTED` on `Explore`:

- **Match the built-in's capitalisation exactly.** `nam<configured-path>Explore` overrides;
  `nam<configured-path>explore` does not — tested behaviour beats the docs' lowercase-hyphen rule.
  Custom `mp-*` agents stay lowercase-hyphenated.
- **Copy the built-in's `description` verbatim.** It drives auto-delegation; rewording
  changes *when* runtime delegates.
- **Keep the body thin.** The override replaces the built-in's tuned system prompt.
- Agent definitions apply mid-session; a new skill needs a new session. The two reload
  semantics differ — generalising from one to the other produces wrong diagnoses.

## 5. Verify by attempting, never by asking

`TESTED` — asked whether `Edit` was available, an agent answered yes; the actual call
returned `No such tool availabl<configured-path>Edit`.

- **Permissions**: make the agent attempt the call and report the verbatim result.
- **Models**: read `toolUseResult.resolvedModel` from the session `.jsonl` — recorded at
  spawn time only, and not a whole-run guarantee. Asking an agent which model it is
  produces no reliable evidence.
- `python3 scripts/analyze-subagent-models.py` joins spawns to sidechain transcripts and
  reports what actually ran (defaults to `~/.runtime/projects`).

## 6. Model classes

Skills describe work with a **model class**; harness resolvers pick the concrete model.
Prose model names configure nothing (§ 1), and shared skills must stay portable across
harnesses.

| Model class | the active runtime | Pi | Best for |
| --- | --- | --- | --- |
| `mechanical` | `appropriate runtime class`, no effort | Luna, `low` thinking | Bounded, no-judgment wor<configured-path>checks, commits, lookups |
| `standard` | `appropriate runtime class`, `low` or `medium` | Terra, `low` or `medium` | Exploration, review, docs, bounded judgment |
| `advanced` | `appropriate runtime class`, task-matched effort | Sol, task-matched | Implementation, design, architecture, deep analysis |
| `frontier` | `fable`, `high` effort | Sol, `high` | Deliberate manual escalation for large-task orchestration |

`frontier` is never a standing sub-agent class — no generated frontier agents exist.
`high` is the automatic-agent effort ceiling; Pi's `xhigh`/`max` are prohibited.
Frontmatter and tool calls still use harness-native `mode<configured-path>values — classes are policy
terms, not valid `mode<configured-path>values.

## 7. Effort

- `DOC` — `effor<configured-path>(`low`/`medium`/`high` permitted here) is **frontmatter-only**; the
  `Agent` tool has no `effort` parameter. `TESTED` — prose never sets it, and `Explore`
  breadth wording ("very thorough") is search scope, not reasoning effort.
- **Omitting `effor<configured-path>inherits the caller's effort** — pin it explicitly on every
  non-appropriate runtime class agent, or an agent meant to run cheaply runs at `high` whenever the
  orchestrator does. Effort is inert on appropriate runtime class (`TESTED`) — leave it unset there.
- `TESTED` verdicts (raw tables in docs/SUBAGENTS.md):
  - **Search**: appropriate runtime class at `low` matches `medium` and matches appropriate runtime class on multi-hop tracing, at
    a third of appropriate runtime class's cost. `Explore` keeps `effor<configured-path>low`.
  - **Review**: `medium` is the knee — full seeded-defect recall (10/10 vs `low`'s 8/10)
    at the same cost as `high`, zero false positives at every level. `reviewer-*` pin
    `effor<configured-path>medium`. `UNVERIFIED` for `scanner-architecture` and `issue-analyzer` —
    different task shapes, not benchmarked.
  - **Browser work is the exception**: appropriate runtime class scored 3/10 at `low` vs 9/10 at `high`, so
    `chrome-devtools-tester` keeps `effor<configured-path>high`.
  - **appropriate runtime class wins only tightly scoped contracts** (`checker`, `git-committer`); where
    the agent must explore and compose (`pr-manager`) appropriate runtime class cost 2.4× appropriate runtime class.

## 8. Model by task shape — horizon, not difficulty

`EXTERNAL` — DeepSWE v1.1: on long-horizon autonomous work, appropriate runtime class 5 costs 2.2× appropriate runtime class 4.8
per task while scoring *lower*, and appropriate runtime class scores ~0. Long-task spend is dominated by wrong
turns, not token price. The rule that falls ou<configured-path>- **Bounded** (one deliverable, exploration done by the caller): cost scales with tokens —
  the cheap model wins.
- **Open-ended** (the agent explores, decides, self-corrects): cost scales with wrong
  turns — the capable model is usually also the cheaper one.

| Task shape | Model class | runtime effort | Agents |
| --- | --- | --- | --- |
| Orchestration (multi-phase loop) | frontier or advanced | high | the session; nested orchestrators |
| Issue/codebase analysis → fix plan | advanced | high | `issue-analyzer` |
| Design, architecture, interface | advanced | medium | `ui-variant-generator` |
| Implementation — iterating to green | advanced | medium | `tdd-executor` |
| Implementation — pre-analysed chunk | advanced | low | `executor` |
| Exploratory loop against live feedback | advanced | high | `chrome-devtools-tester` |
| Review | standard | medium | 7 × `reviewer-*`, `scanner-architecture` |
| Exploration / codebase search | standard | low | `Explore` |
| Bounded, some judgment | standard | low | `pr-manager`, `issue-finder`, `unresolved-issue-tracker` |
| Bounded, no judgment | mechanical | — | `checker`, `git-committer`, `context7-docs-fetcher` |

- `general-purpose` and `runtime` declare neither model nor effor<configured-path>mode<configured-path>is
  load-bearing at every such call site, and effort is simply not settable — it inherits
  the caller's. Writing `effor<configured-path>into a spawn instruction is a defect, not configuration.
  Where a specific effort matters, use a real `mp-*` agent with it pinned; otherwise shape
  behaviour through prompt content ("keep this a scan, not a review"), which does work.
- Two pins are contract-dependen<configured-path>executor` is `low` only because callers pre-analyse
  and hand it a bounded scope — see [EXECUTOR_CONTRACT.md](EXECUTOR_CONTRACT.md); a vague
  prompt puts it back in the open-ended regime where `low` is wrong. `tdd-executor`
  gets `medium` because iterating to green is exactly the wrong-turn regime.
- `EXTERNAL` — Design Aren<configured-path>**effort buys function, not looks** (a full low→high sweep
  moves aesthetic Elo ≈ +15; the appropriate runtime class-over-appropriate runtime class model gap is ~130 Elo, worth ten times
  any effort setting). Design work never drops below appropriate runtime class. `ui-variant-generator` sits
  at `medium` because effort throttles *all* output tokens, not just thinking — a
  low-effort variant writes visibly less markup and CSS.

## Related

- [docs/SUBAGENTS.md](../../docs/SUBAGENTS.md) — raw benchmark evidence behind every `TESTED` verdict
- [EXPLORATION.md](EXPLORATION.md) — when and how to delegate searches
- [AUTHORING.md](AUTHORING.md) — conventions shared by skills and agents
