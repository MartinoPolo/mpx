# Sub-Agent Protocol

Canonical rules for delegation, model classes, tools, evidence, and runtime drift. Runtime adapters resolve these
policies to concrete harness fields and model IDs.

## Model selection

Only structured runtime configuration selects a model; prose model names do not. Canonical call sites use model classes:

| Class         | Best for                                                  |
| ------------- | --------------------------------------------------------- |
| `mechanical`  | bounded checks, commits, lookups with no judgment         |
| `exploration` | broad codebase discovery and repository search            |
| `standard`    | review, documentation, and bounded judgment               |
| `advanced`    | implementation, design, architecture, and deep analysis   |
| `frontier`    | deliberate manual escalation for large orchestration only |

An agent definition should declare its class and effort policy. Callers omit model selection for a declaring agent.
Generic agents with no declaration require an explicit class at every call site. A runtime resolver maps class to an
available model and records the resolved model in execution evidence. Concrete vendor model IDs never appear in
canonical instructions.

Select by task horizon, not perceived difficulty. Bounded tasks benefit from smaller classes; open-ended loops need
enough capability to avoid expensive wrong turns. `frontier` is not a standing automatic-agent class.

## Effort

Effort is runtime configuration, not prompt prose. Pin it in the agent definition when the runtime supports it:

- exploration: `exploration`, medium;
- review: `standard`, medium;
- implementation with a pre-analyzed chunk: `advanced`, low;
- TDD iteration and design: `advanced`, medium;
- live browser exploration: `advanced`, high;
- mechanical tasks: resolver default.

Do not request effort levels beyond the adapter's approved ceiling. If effort cannot be set at a call site, choose a
canonical agent that declares it or accept documented inheritance.

## Orchestration and nesting

Fan out from the parent by default. Sub-agents must not assume they can spawn children or inherit the parent's tools,
repository instructions, git status, machine roots, or provider identity. Prompts include the bounded context needed for
the job. An agent without delegation authority returns the exact capability needed to its parent.

Runtime ceilings and nesting behavior drift. Adapters declare tested runtime versions and fail closed when a required
grant is unavailable; canonical policy does not encode version-specific tool names.

## Tool grants

Treat tool declarations as least-privilege allowlists and runtime denials as subtractive. Effective tools may be
narrower than declarations. Verify critical capability by attempting a safe bounded operation and recording the
structured result, not by asking the model what it can do.

MCP-dependent work uses an identity-owned approved route. Check capability availability first. If unavailable, return
structured unsupported/manual handoff rather than silently switching to web search, direct APIs, provider CLIs, or
copied credentials.

## Built-in overrides and discovery

Runtime adapters may override built-ins to project canonical agents. Preserve any runtime-required identity
capitalization and routing description, keep the override body thin, and test reload and auto-delegation behavior on
every adapter version change. These are projection concerns, not canonical names.

## Evidence and drift

Measure resolved model, tools, and runtime behavior from structured session evidence. Do not trust model self-report.
Each projection records canonical source/version and adapter version. Re-run behavior probes after runtime upgrades,
tool-server renames, resolver changes, or permission-policy changes; stale measured claims are defects.

## Task-shape defaults

| Task                                   | Class / effort                                        |
| -------------------------------------- | ----------------------------------------------------- |
| multi-phase orchestration              | `advanced` high; `frontier` only by manual escalation |
| issue/codebase analysis                | `frontier` high                                       |
| design/architecture/interface          | `frontier` medium                                     |
| implementation to green                | `advanced` medium                                     |
| pre-analyzed implementation            | `advanced` low                                        |
| interactive browser loop               | `advanced` high                                       |
| review                                 | `standard` medium                                     |
| codebase exploration                   | `exploration` medium                                  |
| bounded composition/finding            | `standard` low                                        |
| deterministic check/commit/docs lookup | `mechanical`                                          |

Two contracts are load-bearing: `mpx-executor` receives a pre-analyzed bounded scope, while `mpx-tdd-executor` owns
red/green iteration. A vague executor prompt violates [EXECUTOR_CONTRACT.md](EXECUTOR_CONTRACT.md) rather than
justifying silent model drift.

## Related

- [EXPLORATION.md](EXPLORATION.md)
- [AUTHORING.md](AUTHORING.md)
- [EXECUTOR_CONTRACT.md](EXECUTOR_CONTRACT.md)
