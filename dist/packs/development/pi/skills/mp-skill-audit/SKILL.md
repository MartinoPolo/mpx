---
argument-hint: "[skill name or path]"
description: Loads the mp-skill-audit skill when explicitly referenced.
metadata:
  author: MartinoPolo
  category: utility
  version: "1.0"
name: mp-skill-audit
triggers: audit skill; audit all active skill roots; fix mechanical skill-authoring drift
---

# Skill Audit

Read [Authoring Conventions](../../../../../pi/instructions/shared/AUTHORING.md),
[Writing for Agents](../../../../../pi/instructions/shared/WRITING_FOR_AGENTS.md),
[Sub-Agent Protocol](../../../../../pi/instructions/shared/SUBAGENT_PROTOCOL.md), and [Exploration](../../../../../pi/instructions/shared/EXPLORATION.md)
completely before auditing. With `the invocation input`, audit only the named skill or path; without
it, audit every active root.

Resolve assets relative to this loaded skill; follow [Content Paths](../../../../../pi/instructions/shared/CONTENT_PATHS.md)
when a tool requires an absolute path.

## Workflow

1. **Discover active roots.** Identify the repository root and inspect repository configuration, compiler contracts,
   runtime-profile configuration, package configuration, and top-level
   layout for every configured canonical or project skill root. Include conventional nested
   `skills/**/SKILL.md` locations. Exclude deprecated content, fixtures, generated projections,
   dependencies, and worktree metadata. Resolve `the invocation input` against an inventory that
   states every root's discovery source and assigns each included `SKILL.md` to exactly one root.

2. **Read complete inputs.** Read every selected `SKILL.md`, every directly linked local reference
   or script, relevant repository configuration and compiler contracts, and the runtime profiles that translate its metadata. Prefer a
   named existing audit agent when its documented role matches the assigned checks. Otherwise use
   the documented runtime `general-purpose` built-in: inspect the existing runtime profiles, resolve
   the standard class to a concrete model that is actually available, and pass that resolved value
   through the runtime's real `model` argument with medium effort; `model="advanced"` and other
   prose class names are not executable model values. Batch three to five skills per parallel
   sub-agent, keep repository-wide checks in the main session, assign every selected file exactly
   once, and require each auditor to confirm complete-file reads and list the files read.

3. **Apply all checks.** Evaluate every check below for every selected skill. Record **pass**,
   **finding**, or **not applicable** for every check and cite file, line or section, and evidence
   for every finding. Run each repository-wide check once. Preserve findings even when a later
   mechanical fix resolves them so the report can distinguish found, fixed, and remaining.

4. **Fix mechanical drift.** Auto-fix only deterministic changes: safe positive reframing, missing
   canonical bookkeeping fields with known values, category or pack casing where the schema defines
   it, and verified legacy-link replacements. Preserve intent and update
   `metadata.mpx.contentVersion` only according to the canonical schema's versioning policy; never
   invent an unsupported version value. Do not edit generated runtime projections directly. Reread
   every applied edit and re-run affected checks. Keep unsafe automation as a manual finding with
   the reason it requires judgment.

5. **Report complete accounting.** Output the required summary table, then group remaining findings
   by skill and check number. Account for every selected skill and active root, include every
   finding and modified file exactly once, identify runtime-profile translations inspected, and
   report unresolved no-op tests as behavioral judgments rather than textual certainty.

## Checks

1. **Positive targets:** Inspect negative phrasing. Reframe when behavior remains equivalent; retain
   surprising, irreversible, security, identity, or false-success guardrails paired with the desired
   behavior.
2. **Size and split rationale:** Flag `SKILL.md` over 200 lines, splits justified only by line
   count, and unsplit material with genuine branch or sequence boundaries. Treat line count as a
   guardrail, not a rule that overrides hierarchy.
3. **Canonical frontmatter:** Require `name`, portable `description`, and only the `metadata.mpx` fields accepted by the
   current compiler schema: `schemaVersion`, `skillPacks`, and optional `defaultExposure`. Validate
   top-level `argument-hint` and `triggers` when present.
   Reject runtime-native fields in canonical source and verify compiler-owned translation rather
   than requiring legacy `author`, `version`, `category`, or `allowed-tools` fields.
4. **Portable context pointer:** Ensure the description states purpose and every distinct trigger
   branch in at most two concise sentences. `triggers` may improve search but must not be the only
   copy of a routing branch. Flag excessive combined listing metadata and ask whether broader
   exposure earns its context cost.
5. **Legacy docs and paths:** Find obsolete `REQUIREMENTS.md`, `VOCABULARY.md`, `ARCHITECTURE.md`,
   `legacy`, fallback references, old absolute roots, and runtime-only source paths. Replace only
   when the current canonical target is verified. Require compiled-relative references plus the
   `CONTENT_PATHS` runtime-read procedure.
6. **Explicit capabilities:** Name exact canonical agent identities, semantic model classes, MPX
   capabilities, repository-relative scripts, and delegated exploration breadth wherever used.
   Verify runtime profiles translate semantic capabilities and model classes to concrete
   tools/models.
7. **Vocabulary confirmation:** Skills writing the Domain Language section of `.mpx/CONTEXT.md` show
   the complete proposed text and obtain user confirmation before writing.
8. **Description behavior:** Verify every claimed capability exists and every delegation or
   invocation branch in the body is represented by the description.
9. **Agent identities:** Verify each spawn names an existing canonical `content/agents/<type>.md`, a
   documented runtime-neutral built-in, or a named runtime capability with an explicit unsupported
   handoff. Ensure runtime projections translate identities without changing semantics.
10. **Grant paths and projection:** Resolve every path-like capability/allowlist entry after
    supported root expansion and wildcard handling. Compile or inspect projection plans to verify
    direct references remain correct relative to emitted files and use `CONTENT_PATHS` only when
    relocation requires an absolute runtime read.
11. **Dead grants:** Match every canonical capability to body behavior and every capability use to a
    grant. Then inspect runtime translation for unintended widening, missing tools, or unsupported
    omissions.
12. **README sync (repository-wide):** Compare all discovered active skill roots, agents, hooks,
    packs, and public identities with README tables or generated inventories. Report drift for the
    owning documentation workflow rather than editing out-of-scope files.
13. **Model mechanics:** Flag prose-only model selection, concrete vendor model IDs in canonical
    content, redundant or missing structured model classes/effort per Sub-Agent Protocol,
    unsupported classes, and runtime profiles that fail to record translation. Call-site effort is
    valid only where the canonical protocol and adapter support it.
14. **Shared integrity (repository-wide):** Resolve shared links from every active root. Flag copied
    shared rules that should be precise pointers and direct links that do not survive
    compiled-relative projection.
15. **Exploration:** Require broad discovery to use `mpx-explorer` or the documented exploration
    capability with quick, medium, or very-thorough breadth and a stopping condition. Exempt
    deterministic inventories of fixed known patterns.
16. **Personal paths:** Scan selected skill files and assets for personal roots or usernames.
    Require runtime resolution through named `MPX_*` environment variables and loud failure when
    unset. Exempt documented runtime variables and genuine system paths; reject guessed fallbacks.
17. **Semantic completion:** Assess whether every procedural step has an unambiguous behavioral
    endpoint. Flag plausible premature or false completion, no-op completion restatements, detached
    validation or stop conditions, and standalone gates outside approved ambiguous or risky
    transitions. Do not search for or require literal completion phrases.
18. **Hierarchy and disclosure:** Classify procedural, reference, or mixed structure. Verify actions
    precede supporting detail, concepts are co-located, and branch-only material is disclosed
    through precise one-level pointers.
19. **Single source and caches:** Flag duplicated meanings and environment facts cheaply
    discoverable from manifests, config, layout, scripts, runtime profiles, or `--help`. Retain
    reasons, policy, and hidden conventions that cannot be safely rediscovered.
20. **Relevance and no-ops:** Flag stale or unrelated sentences. Compare suspected no-ops
    behaviorally against the target model/runtime default and preserve them as manual findings when
    behavior cannot be measured; never auto-delete solely from textual heuristics.

## Output contract

```markdown
| Skill      | Checks with findings |   Fixed | Remaining |
| ---------- | -------------------: | ------: | --------: |
| [identity] |         [count/list] | [count] |   [count] |

Active Roots:

- [root -> discovery source -> selected skills]

Fixed:

- [skill, check number, file, deterministic change]

Remaining Findings:

- [skill, check number, evidence, required decision]

Runtime Translation Evidence:

- [profile/compiler result]

Files Modified:

- [path]

Manual No-op Tests:

- [none or behavioral finding]
```
