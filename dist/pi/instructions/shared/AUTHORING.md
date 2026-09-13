# Authoring Conventions

Rules shared by canonical MPX skills, agents, and instructions. For delegation and model selection,
see [SUBAGENT_PROTOCOL.md](SUBAGENT_PROTOCOL.md). For agent-facing prose, see
[WRITING_FOR_AGENTS.md](WRITING_FOR_AGENTS.md).

## Canonical locations and identities

| Artifact           | Canonical path                          | Identity                                      |
| ------------------ | --------------------------------------- | --------------------------------------------- |
| Skill              | `content/skills/<name>/SKILL.md`        | bare `<name>`; native `/skill:mp-<name>` |
| Agent              | `content/agents/<role>.md`              | bare `<role>`; projected `mpx-<role>` |
| Shared instruction | `content/instructions/shared/<NAME>.md` | no frontmatter identity                       |

Canonical content is runtime-neutral. The compiler projects identities, frontmatter, tool names, and
invocation syntax; canonical files do not encode a particular harness. Keep the filename,
directory identity, and declared identity aligned wherever a projection requires all three.

## Descriptions and discovery

Descriptions are context pointers, not implementation summaries. Front-load the trigger and say what
the artifact does in one or two sentences. Put every distinct routing fact in the portable
`description`; optional adapter-specific metadata may enrich it but must not contain the only copy
of a trigger. Agents use one concise line, normally no more than 250 characters.

Default skills to explicit invocation unless autonomous discovery is necessary. This avoids charging
every session for skills a user always selects by name. Adapter projections own the exact
frontmatter field used to disable implicit invocation.

## Provider artifact terminology

Use **pull request (PR)** as the common user-facing shorthand. At a cross-provider workflow's
introduction, clarify once that PR means a GitHub pull request, GitLab merge request, or Gerrit
change as applicable; use PR thereafter. Use native provider vocabulary where types must be
distinguished and at command boundaries. Reserve **review** for the act of code review. Existing
internal type and agent names such as `Review`, `review_id`, and `mpx-review-manager` are not CLI
commands and should be identified as internal when ambiguity is possible.

## Positive and explicit instructions

State the behavior to perform. Retain negative instructions for surprising constraints, irreversible
actions, or false-success hazards. At every call site name:

- the exact projected agent identity, such as `mpx-explorer`;
- the required model class when the callee does not declare one;
- the provider intent and explicit repository or board target;
- the repository-relative script and invocation;
- exploration breadth and stopping condition.

Resolve provider operations through [ISSUE_TRACKER.md](ISSUE_TRACKER.md). Canonical content may
invoke only the native commands documented by the selected guide under
[PROVIDER_ROUTING.md](PROVIDER_ROUTING.md); never inline an ungoverned provider fallback or infer a
provider from remotes.

## Paths and private data

Canonical content contains no personal absolute paths. Machine roots are supplied through `MPX_*`
environment variables described in [EXPLORATION.md](EXPLORATION.md). Resolve a needed root at
runtime and fail with a message naming an unset variable; do not guess or fall back to the working
directory.

Do not assume markdown interpolates environment variables. Follow
[CONTENT_PATHS.md](CONTENT_PATHS.md): keep canonical links relative, and when a runtime tool needs
an absolute path, resolve `MPX_ACTIVE_CONTENT_ROOT` once and pass the resulting literal. A runtime
adapter may define a small documented placeholder set only in its generated projection.

User-facing generated assets go beneath `MPX_AI_GENERATED`, in an all-caps underscore-prefixed
category folder, with one subfolder per run containing the inputs, prompt, and deliverables.
Intermediates stay in session scratch space.

## Size and progressive disclosure

Keep a skill entry point near 200 lines. When a branch needs substantial detail, move that detail to
a one-level-deep reference and link it at the decision point. Keep agent bodies near 100 lines and
single-purpose. A line limit is a guardrail: split by a real branch or context boundary, not to
satisfy arithmetic.

Use a script when behavior is deterministic, repeatable, requires explicit error handling, or would
otherwise need a long inline shell fragment.

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
- When porting an existing skill, preserve its author, version, and category bookkeeping and
  continue the original version lineage rather than resetting it.
- Use the existing version shape. Do not renumber older three-part versions solely for consistency.
- Update adjacent user documentation in the same change when behavior changes.
- Generated projections must pass deterministic drift validation against canonical content.
- A runtime-specific workaround must name its measured runtime/version and be re-tested before the
  projection carries it forward.
- Delete superseded artifacts after their consumers and replacement are verified; Git retains
  history.
- Use conventional commits.
