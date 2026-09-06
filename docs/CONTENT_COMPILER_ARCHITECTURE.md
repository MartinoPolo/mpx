# MPX Content Compiler Architecture

Status: implemented for canonical skill and agent compilation

## Purpose

MPX must keep one canonical source for skills, agents, shared instructions, rules, and hook declarations while producing native Claude Code and Pi content. Translation must be deterministic, lossless except for explicit exposure policy, and visible to users and agents.

The file inspected through MPX must be the exact file supplied to the runtime. Runtime adapters may assemble and launch a projection, but they must not rewrite compiled skill or agent bytes.

## Core decisions

- One shared content compiler owns canonical parsing, launch selection, provider translation, reference packaging, and final skill/agent rendering. Runtime adapters copy compiled skill and agent bytes unchanged and never receive agent model mappings.
- Claude and Pi receive separate generated projections from the same compiler implementation.
- Every directory skill is emitted as uppercase `SKILL.md` for both runtimes.
- Launch-specific content scopes, skill packs, exposure overrides, and project-local skills remain supported.
- Provider-neutral MPX commands own Issue, Review, and CICI routing. Skills do not translate `mpx issue create` into provider CLIs.
- Runtime and model differences live in one tracked, validated translation profile.
- Canonical agents use semantic model classes: `mechanical`, `standard`, `advanced`, and `frontier`.
- Unknown fields, placeholders, model classes, capabilities, references, or required runtime features fail closed.
- Generated active content is persistent and directly inspectable.
- Root and group CLI help use progressive disclosure rather than returning usage errors for incomplete command groups.

## Canonical content layout

Target layout:

```text
content/
├── skills/
│   └── <name>/
│       ├── SKILL.md
│       ├── references/
│       ├── scripts/
│       └── assets/
├── agents/
├── shared/
├── rules/
├── hooks/
├── output-styles/
└── runtime-profiles.json
```

During migration, shared instructions and generated CLI references remain under `content/instructions/shared`, while rules remain under `content/instructions/rules`. The target layout above moves those inputs to `content/shared` and `content/rules` in a later chunk; this chunk does not move the existing shared tree. Final projected links such as `../shared/AUTHORING.md` must resolve without a test-only path redirect.

Canonical content contains semantic fields and MPX capabilities, not vendor model IDs or harness-native tool names.

## Canonical skill contract

The compiler validates one strict schema. A representative skill is:

```yaml
---
name: issue-create
description: 'Creates a clear provider-neutral Issue, optionally linked to an Epic. Use when the user says ‘create issue’, ‘file issue’, or asks to record actionable work.'
argument-hint: '<title or description> [--epic <id>]'
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: name-only
    capabilities: [read, shell, delegate]
---
```

The portable description states what the skill does and every distinct trigger branch. Use concrete routing language such as `Use when the user says “create issue”`. Optional runtime enrichment must not carry a unique trigger.

### Exposure semantics

| Exposure        | Generated behavior                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `full`          | Emit the full canonical description and allow model invocation.                                    |
| `name-only`     | Emit a generic name-trigger description and allow model invocation.                                |
| `explicit-only` | Preserve the full description on disk and emit the runtime control that disables model invocation. |
| `off`           | Do not emit the skill.                                                                             |

`name-only` is required because explicit-only skills cannot be loaded when a user merely mentions the skill name in prose.

A missing or empty description cannot represent name-only:

- the Agent Skills standard requires a description;
- Pi rejects skills with missing or empty descriptions;
- Claude falls back to the body’s first paragraph when description is omitted.

For name-only, both runtime files receive the same generated description:

```yaml
description: 'MPX skill issue-create. Load only when the user explicitly mentions ‘issue-create’ by name.'
```

`disable-model-invocation` remains omitted. The active manifest records the canonical and effective descriptions and the name-only decision.

### Invocation input

Canonical bodies should normally say `the invocation input` rather than using a provider placeholder.

- Claude appends `ARGUMENTS: <value>` when no argument placeholder consumes the arguments.
- Pi appends supplied arguments after the skill body.

A typed invocation placeholder is reserved for workflows that require positional or named interpolation. The compiler must reject it when the selected runtime cannot preserve the requested semantics.

## Native runtime skill outputs

### Claude Code

```text
<projection>/
├── .claude-plugin/plugin.json
├── skills/
│   ├── <name>/SKILL.md
│   └── shared/
├── agents/
├── hooks/hooks.json
├── output-styles/
└── active-content.json
```

A plugin skill with identity `issue-create` is invoked as `/mpx:issue-create` when the generated plugin is named `mpx`.

Claude-specific fields may include:

- `argument-hint`;
- `arguments`;
- `when_to_use`;
- `disable-model-invocation`;
- `user-invocable`;
- `allowed-tools` and `disallowed-tools`;
- `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, and `shell` where requested by semantic configuration.

Only fields required by the skill are emitted. `allowed-tools` is a temporary permission grant, not a restrictive allowlist.

### Pi

```text
<projection>/
├── skills/
│   ├── <name>/SKILL.md
│   └── shared/
├── agents/
├── runtime-context.json
├── runtime-profile.json
└── active-content.json
```

Pi implements Agent Skills directory discovery and natively invokes a skill as `/skill:<name>`.

Pi documents `name`, `description`, `license`, `compatibility`, `metadata`, experimental `allowed-tools`, and `disable-model-invocation`. The installed implementation currently consumes name, description, and disable-model-invocation for discovery behavior. The compiler must not claim that an experimental or ignored field enforces a capability.

Normal MPX launches register canonical skills as `/mpx:<name>` through the checked-in native extension package. The extension advertises only manifest-authorized metadata and lazily loads compiler-owned bodies from the verified active projection. The launch binds the manifest bytes and runtime context; invocation revalidates the manifest and selected skill bytes. Project skills retain native `/skill:<name>` commands. Canonical skills are not also supplied to native skill discovery, preventing duplicate commands. Non-MPX native Pi sessions are unchanged.

## Description policy

- Preserve the canonical description exactly for full and explicit-only projections.
- Replace it only for name-only, using the tracked generic template.
- Never generate opaque descriptions such as `mpx skill <name>` without the explicit mention instruction.
- Keep both canonical and effective descriptions in the active manifest.
- Prefer omitting `when_to_use`. If emitted for Claude, it can only repeat or enrich triggers already present in description.

## Translation profile

`content/runtime-profiles.json` is the single tracked source for deterministic runtime mappings. It is validated before compilation.

Required model mappings:

| Semantic class | Claude   | Pi                           |
| -------------- | -------- | ---------------------------- |
| `mechanical`   | `haiku`  | `openai-codex/gpt-5.6-luna`  |
| `standard`     | `sonnet` | `openai-codex/gpt-5.6-terra` |
| `advanced`     | `opus`   | `openai-codex/gpt-5.6-sol`   |
| `frontier`     | `fable`  | `openai-codex/gpt-5.6-sol`   |

The profile also owns:

- semantic capability to runtime tool mappings, with grant support recorded as `preapproved` or `unsupported`;
- the shared skill capability vocabulary: `read`, `search`, `shell`, `write`, and `delegate`;
- runtime skill command formats;
- runtime agent aliases;
- exposure field mappings;
- argument-hint support;
- provider-only frontmatter names and support levels;
- the name-only description template;
- the typed placeholder registry.

Unsupported optional fields are omitted and recorded. Unsupported required behavior fails compilation.

Claude capability grants are least-privilege pre-approvals: `read` maps to `Read`, `search` to `Glob` and `Grep`, `shell` to `Bash`, `write` to `Write` and `Edit`, and `delegate` to `Agent`. Pi grant support is `unsupported`, so Pi output omits `allowed-tools`. A skill's optional semantic capabilities remain visible in the active manifest, alongside `capabilityGrantsApplied` and `capabilityGrantSupport`; a required grant fails closed when the selected runtime is unsupported.

## Typed substitutions

Most body text is preserved byte-for-byte. Substitution is restricted to a declared registry.

### Launch values

Examples:

- `{{launch.identity}}`
- `{{repository.root}}`
- `{{repository.id}}`
- `{{project.id}}`

Values have declared types and escaping rules. Secrets and credential paths are not valid substitutions.

### Agent identities

Examples:

- `{{agent.explorer}}`
- `{{agent.executor}}`

The profile resolves canonical identities to runtime aliases. Unknown aliases fail compilation.

### Runtime capabilities and tools

Tool names normally come from structured frontmatter, not body substitutions. A body token is allowed only when prose must name a runtime-native mechanism.

### MPX commands

Provider-neutral commands normally remain literal and unchanged:

- `mpx issue ...`
- `mpx review ...`
- `mpx ci ...`
- `mpx tool invoke ...`

These commands route through the launch-selected provider. They are not translated to `gh`, `glab`, or another provider CLI.

### Runtime locations

Runtime-specific skill or plugin roots may be substituted only where a bundled script requires an absolute runtime path. Relative links and skill-local scripts are preferred.

### Compiler rules

- Unknown placeholders fail.
- Missing required values fail.
- No unresolved placeholder survives output.
- Substitution does not occur inside literal examples unless explicitly enabled.
- Every transformed field and token is represented in the active manifest.

## Provider-specific workflow variants

The existing implementation selects packs, exposure, and project skills by launch context. It does not currently select different skill bodies for GitHub or GitLab.

Do not add provider variants merely to route API calls. `mpx issue create` already selects the configured Issue provider and verifies its capabilities.

A provider-specific body variant is allowed only when the human workflow materially differs and cannot be expressed through the provider-neutral contract. Variant selection uses a bounded declarative schema with exact provider dimensions and a required default. Free-form expressions and embedded scripts are forbidden.

The selected output contains one straight workflow without unresolved provider branches.

## Shared content

Shared references are compiler inputs and final projection files. The compiler must collect, hash, and copy every referenced shared document needed by a selected skill.

Final layout preserves references such as:

```text
skills/issue-create/SKILL.md
skills/shared/ISSUE_TRACKER.md
```

The final-artifact closure check resolves links exactly as the runtime will see them. Tests must not special-case a missing projected path.

## One compiler implementation

Create `packages/content-compiler` as the only package allowed to render skills and agents.

Conceptual API:

```ts
compileContent({
  runtime,
  canonicalContent,
  agentRoot,
  projectSkills,
  contentScope,
  skillPacks,
  exposurePolicy,
  runtimeProfile,
  launchBindings,
}): CompiledContentTree
```

The result contains final bytes and an inspection manifest. The same API is called by launch, export, check, and tests.

Runtime packages retain native execution concerns:

- plugin or extension assembly;
- hooks and settings wiring;
- status and runtime context;
- executable invocation;
- runtime capability probes.

Runtime packages must not parse canonical skill metadata or modify compiled skill and agent bytes.

The independent Claude agent renderer, Pi agent generator/check path, tracked Pi agent projection, Pi `body.md` representation, and duplicated runtime-specific metadata mappings have been removed. Themes, runtime assets, and the vendored Pi subagent implementation remain runtime-owned.

## Active generated content

Every launch currently materializes a persistent readable, content-addressed tree beneath the existing runtime-artifacts root. The selected provider executes this exact published tree, and `mpx content inspect` is the stable inspection surface regardless of its physical location.

A human-readable relocation beneath the following machine-state path is a later optional improvement, not a prerequisite for inspection:

```text
%LOCALAPPDATA%/mpx/content/<repository>/<runtime>/<launch-key>/
```

Relocation must not introduce a copied projection or change the provider/inspection byte identity.

The launched process receives:

```text
MPX_ACTIVE_CONTENT_ROOT
MPX_ACTIVE_CONTENT_MANIFEST
```

`active-content.json` records:

- schema and compiler versions;
- launch key and runtime;
- repository, project, content-scope, pack, and policy bindings;
- included and excluded skills with reasons;
- project-local skills;
- canonical and effective descriptions;
- selected variants;
- semantic and concrete agent models;
- source and generated paths;
- final hashes and byte counts;
- omitted optional runtime features and capability-grant support/application status;
- every substitution and its non-secret source category.

Inspection reads these existing files rather than recompiling them.

## Content CLI

The initial focused content group contains only the common active inspection operations:

```text
mpx content inspect
mpx content inspect skill <identity>
mpx content inspect agent <identity-or-projected-name>
mpx content check
```

`inspect` verifies and reads the exact active file; all inspection actions consume the persisted `active-content.json` and never rebuild. Diff, export, open, and any optional relocation remain later work.

## Progressive CLI help

One command metadata registry owns parsing help, terminal help, examples, and generated agent documentation.

Behavior:

- `mpx` prints fewer than twenty common command groups and exits successfully.
- `mpx <group>` prints at most ten common actions and exits successfully when the group has no default action.
- `mpx <group> --help` prints focused group help.
- `mpx <group> <action> --help` prints command-specific usage and examples.
- `mpx help --all` exposes the complete inventory.
- Unknown commands remain errors.
- Missing required leaf arguments show concise command-specific usage.
- `--json` retains stable structured error envelopes for automation.

Generate two concise references from the same registry. Their current migration location is:

- `content/instructions/shared/MPX_CLI_BASIC.md`: common operations and examples;
- `content/instructions/shared/MPX_CLI_REFERENCE.md`: complete command inventory.

Their target location is `content/shared/` after the shared-tree migration. Agent instructions load the basic reference first and the complete reference only when the basic one is insufficient.

## Symlink policy

Normal MPX launches pass the active generated root directly to Claude or Pi. No symlink is needed.

An optional installer-owned link may expose one compiled projection to a provider launched outside MPX. It must:

- link only from a provider-owned registration path to a real generated tree;
- never place symlinks inside canonical or generated content;
- refuse to replace foreign paths;
- record ownership for safe upgrade and uninstall;
- warn that one global link cannot represent concurrent repository-specific launch contexts.

## Integrity boundary

Retain checks that protect the final executed result:

- strict canonical and profile validation;
- project-skill source containment and integrity;
- deterministic compilation;
- atomic final-tree publication;
- final file hashes;
- final reference closure;
- runtime invocation bound to the exact generated root;
- active inspection that detects post-publication mutation.

Remove intermediate hashes and artifacts only after proving they do not authorize a policy decision, deduplicate a reusable result, or detect meaningful mutation.

## Verification strategy

Keep tests focused on contracts rather than snapshotting the entire corpus:

- canonical schema accepts every supported semantic field and rejects unknown input;
- semantic model classes resolve through the tracked profile;
- full, name-only, explicit-only, and off exposure output is exact for Claude and Pi;
- descriptions are preserved except for the recorded name-only template;
- both runtimes emit `SKILL.md`;
- Pi native invocation receives arguments;
- argument hints and tool grants are emitted only where supported;
- unknown and unresolved placeholders fail;
- final shared references resolve;
- launch and export call the same compiler;
- runtime assembly does not rewrite compiled skill or agent bytes;
- active inspection reports the exact provider input;
- root and group help stay within their disclosure limits;
- generated basic and complete CLI references match the command registry.

## Implementation sequence

### CLI discoverability foundation

Introduce hierarchical command metadata, normal help flags, successful incomplete-group help, and generated basic/full references. This work is independent of content rendering and may proceed in parallel.

### Semantic model profiles

Replace canonical `luna`, `terra`, and `sol` classes with the four semantic classes. Add the tracked runtime profile and route agent generation through validated mappings.

### Shared compiler foundation

Create the compiler package and move canonical parsing, runtime profile parsing, deterministic rendering, and inspection-manifest contracts into it. Initially preserve current runtime output behavior behind compatibility tests.

### Content fidelity migration

Restore argument hints, skill capabilities, metadata versioning, invocation input behavior, and shared references. Replace `runtime-code-guide` with an implemented runtime-aware documentation capability or explicit runtime references.

### Native runtime projections

Emit native `SKILL.md` files for Claude and Pi. Make runtime assembly consume compiler bytes without alteration. Remove Pi `body.md` and its private parser.

### Active inspection

Materialize readable active trees, expose their paths to sessions, and implement the content CLI using the persisted manifest.

### Provider variants

Add bounded provider-specific body selection only after provider-neutral command routing is insufficient for a demonstrated workflow.

### Simplification

Remove duplicate renderers, redundant compatibility layers, and intermediate integrity machinery after behavior and security gates remain green.

## Execution and tracking

This document is the durable architecture and implementation source. It is not a temporary checklist and must remain after implementation so future agents can understand the content boundary.

Implementation work should use isolated worktrees. Independent changes may run in parallel when their file ownership does not overlap. Each merged chunk must preserve the compiler invariant and leave targeted tests green before the next dependent chunk begins.

An external Issue or Epic may mirror progress, but it must link to this document rather than becoming the only source of architecture requirements.
