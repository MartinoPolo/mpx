---
argument-hint: "[skill name or description]"
description: Loads the mp-skill-create skill when explicitly referenced.
metadata:
  author: MartinoPolo
  category: utility
  version: "0.8"
name: mp-skill-create
triggers: create skill; restructure skill; add skill branch, procedure, reference, script, or runtime packaging
---

# Skill Create

Create a portable skill following the target repository's canonical content and compiler
conventions. Use `the invocation input` for known requirements.

Read [Authoring Conventions](../../../../../../claude/instructions/shared/AUTHORING.md) and
[Writing for Agents](../../../../../../claude/instructions/shared/WRITING_FOR_AGENTS.md) completely. When the skill delegates, also
read [Sub-Agent Protocol](../../../../../../claude/instructions/shared/SUBAGENT_PROTOCOL.md). These are the authoritative sources for
writing, invocation, naming, paths, capabilities, model classes, and versioning.

Resolve assets relative to this loaded skill; follow [Content Paths](../../../../../../claude/instructions/shared/CONTENT_PATHS.md)
when a tool requires an absolute path.

## Workflow

1. **Fetch current runtime mechanics.** For runtime or library documentation available through
   Context7, spawn the existing `mpx-context7-docs-fetcher` and ask for the active runtime's current
   skill frontmatter, packaging, invocation, capability-grant, reload, and discovery mechanics with
   runtime-source citations. For installed-runtime mechanics that Context7 does not cover, return a
   bounded handoff asking the parent to read the installed runtime documentation and provide the
   cited findings. Treat only cited runtime facts as platform mechanics, and keep writing advice in
   shared references.

2. **Gather requirements.** In one numbered request, ask for every item not supplied by
   `the invocation input`:
   1. purpose and skill identity;
   2. explicit and implicit invocation policy for each target runtime;
   3. distinct trigger branches and routing phrases;
   4. inputs and outputs for every branch;
   5. ordered actions and semantic endpoints;
   6. points where premature or false completion is plausible;
   7. procedural, reference, or mixed structure;
   8. branch-specific references and examples;
   9. deterministic script candidates;
   10. target packaging and runtime-profile policy, including Codex `agents/openai.yaml` only when
       the target compiler profile requires it.

   Require every field to be answered or marked not applicable. Resolve contradictory requirements
   before drafting.

3. **Design the hierarchy.** Map every requirement to one authoritative location: shared actions in
   `SKILL.md`, branch-only facts in a linked reference, examples in `EXAMPLES.md`, deterministic
   repeated operations in scripts, and runtime-only fields in compiler/runtime profiles. Reach each
   reference through a precise one-level pointer. Split when a branch or sequence changes what a run
   must load; use 200 lines as a guardrail rather than the sole reason.

4. **Draft canonical files.** Discover the configured canonical skill root from repository configuration and compiler contracts; in this repository use `content/skills/<skill-name>/`. Create `SKILL.md` plus only the
   needed `REFERENCE.md`, `EXAMPLES.md`, `scripts/`, assets, and compiler-owned packaging inputs.
   Use portable canonical frontmatter rather than a runtime-native header:

   ```yaml
   ---
   name: <skill-name>
   description: '<portable purpose plus every distinct trigger branch>'
   argument-hint: '[arguments]' # omit when no invocation input is accepted
   triggers: <concise searchable routing phrases>
   metadata:
     author: <author>
     version: '<existing or initial version>'
     category: <category>
     mpx:
       schemaVersion: 1
       skillPacks: [<configured pack>]
       defaultExposure: <explicit-only|name-only|normal>
   ---
   ```

   For a port, preserve the original author, version, and category and continue its version lineage;
   do not reset bookkeeping. The compiler translates `defaultExposure`, names, and declared body placeholders into each
   supported runtime's native invocation policy, frontmatter, commands, and packaging. Put Codex `policy.allow_implicit_invocation: false` in generated
   `agents/openai.yaml` only through the owning runtime profile; do not hand-maintain generated
   projection output. Keep runtime-only `when_to_use`, concrete model IDs, and vendor tool names out
   of canonical content unless the compiler schema explicitly owns them.

   Implement every requested branch. Use concise imperatives with semantic endpoints. Integrate
   relevant validation and stop conditions into their actions, keep runtime-only grants out of skill metadata, and ensure every linked path exists in canonical source and survives
   compiled-relative projection. Add a standalone gate only under shared policy.

5. **Validate and prune.** Compare all drafts with fetched mechanics and shared references. Run
   compiler/frontmatter validation and relevant repository-provided checks when their exact commands
   are available. Apply single-source, environment-cache, relevance, positive-target, no-op,
   hierarchy, path-resolution, grant-integrity, and semantic-completion passes. Treat uncertain
   no-ops as manual behavioral findings and record unmet rules with concrete reasons. Reread every
   changed file completely.

6. **Audit.** Use the documented runtime `general-purpose` built-in. Inspect the existing runtime
   profiles, resolve the standard class to a concrete model that is actually available, and pass
   that resolved value through the runtime's real `model` argument with medium effort;
   `model="advanced"` and other prose class names are not executable model values. Prompt it to run
   the canonical `skill-audit` behavior against `content/skills/<skill-name>/SKILL.md`, passing all
   direct references and the target runtime profiles. Apply only safe mechanical fixes. List
   remaining behavioral findings with owning file, check number, evidence, and required owner
   decision.

7. **Review with the user.** Present created files, explicit invocation syntax, autonomous-discovery
   behavior by runtime profile, branch hierarchy, compiler translations, guideline-driven changes,
   audit results, unresolved findings, and optional improvements. Apply requested revisions,
   revalidate and re-audit affected checks, and iterate until the user approves.

## Final report

```markdown
Files Created/Changed: [paths] Explicit Invocation: [canonical syntax and profile translations]
Autonomous Discovery: [policy by runtime] Branches: [branch -> owning file] Validation: [compiler
and behavioral results] Audit: [fixed and remaining findings] Manual No-op Tests: [none or findings]
Requirement Accounting: [requirement -> owning artifact] Approval: [approved or pending]
```
