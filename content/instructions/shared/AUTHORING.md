# Authoring Conventions

Rules shared by canonical MPX skills, agents, and instructions. For delegation and model
selection, see [SUBAGENT_PROTOCOL.md](SUBAGENT_PROTOCOL.md). For agent-facing prose, see
[WRITING_FOR_AGENTS.md](WRITING_FOR_AGENTS.md).

## Canonical locations and identities

| Artifact           | Canonical path                          | Identity                                       |
| ------------------ | --------------------------------------- | ---------------------------------------------- |
| Skill              | `content/skills/<name>/SKILL.md`        | bare `<name>`; public projection `/mpx:<name>` |
| Agent              | `content/agents/mpx-<role>.md`          | `mpx-<role>`                                   |
| Shared instruction | `content/instructions/shared/<NAME>.md` | no frontmatter identity                        |

Canonical content is runtime-neutral. Runtime adapters project identities, frontmatter, tool
names, and invocation syntax; canonical files do not encode a particular harness. Keep the
filename, directory identity, and declared identity aligned wherever a projection requires all
three.

## Descriptions and discovery

Descriptions are context pointers, not implementation summaries. Front-load the trigger and say
what the artifact does in one or two sentences. Put every distinct routing fact in the portable
`description`; optional adapter-specific metadata may enrich it but must not contain the only copy
of a trigger. Agents use one concise line, normally no more than 250 characters.

Default skills to explicit invocation unless autonomous discovery is necessary. This avoids
charging every session for skills a user always selects by name. Adapter projections own the exact
frontmatter field used to disable implicit invocation.

## Positive and explicit instructions

State the behavior to perform. Retain negative instructions for surprising constraints,
irreversible actions, or false-success hazards. At every call site name:

- the exact canonical agent identity, such as `mpx-explorer`;
- the required model class when the callee does not declare one;
- the provider intent and explicit repository/board target resolved through the shared provider reference;
- the repository-relative script and invocation;
- exploration breadth and stopping condition.

Resolve provider operations through [ISSUE_TRACKER.md](ISSUE_TRACKER.md). Canonical skills may invoke only the native commands documented by its trusted shipped provider references; project configuration never supplies executable commands.

## Paths and private data

Canonical content contains no personal absolute paths. Machine roots are supplied through
`MPX_*` environment variables described in [EXPLORATION.md](EXPLORATION.md). Resolve a needed
root at runtime and fail with a message naming an unset variable; do not guess or fall back to the
working directory.

Do not assume markdown interpolates environment variables. A runtime adapter may define a small,
documented placeholder set, but those placeholders belong only in that adapter's generated
projection. Canonical instructions describe the value semantically or have executable code read
the environment.

User-facing generated assets go beneath `MPX_AI_GENERATED`, in an all-caps underscore-prefixed
category folder, with one subfolder per run containing the inputs, prompt, and deliverables.
Intermediates stay in session scratch space.

## Size and progressive disclosure

Keep a skill entry point near 200 lines. When a branch needs substantial detail, move that detail
to a one-level-deep reference and link it at the decision point. Keep agent bodies near 100 lines
and single-purpose. A line limit is a guardrail: split by a real branch or context boundary, not to
satisfy arithmetic.

Use a script when behavior is deterministic, repeatable, requires explicit error handling, or
would otherwise need a long inline shell fragment.

## Tools and interfaces

Tool grants are least-privilege allowlists. Grant only capabilities the body uses. Do not write
harness-native tool names into shared policy when an MPX capability or model class expresses the
intent. Runtime projections resolve model classes and tool contracts to concrete harness values.

Sub-agents may receive fewer effective tools than their declarations because a runtime can strip
interactive or orchestration tools. Verify critical grants by attempting the operation, not by
asking the model whether a tool exists. Keep MCP registration and tool-prefix details in runtime
adapters; canonical content requests the approved capability.

## Versioning and drift

- Bump a skill's canonical metadata version when behavior changes; trivial wording corrections may
  retain the version.
- Use the existing version shape. Do not renumber older three-part versions solely for consistency.
- Update adjacent user documentation in the same change when behavior changes.
- Generated projections must record their canonical source/version and pass drift validation.
- A runtime-specific workaround must name its measured runtime/version and be re-tested before the
  projection carries it forward.
- Deprecation means moving an artifact to the repository's deprecated area, not deleting history.
- Use conventional commits.
