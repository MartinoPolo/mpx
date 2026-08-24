---
name: skill-audit
description: "Audits all active skills for convention drift and common defects, fixing what it can and reporting the rest."
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: name-only
---
# Skill Audit

Scan all active skills for consistency and convention drift. Auto-fix mechanical issues, report findings.

The conventions being audited are defined in
[`../shared/AUTHORING.md`](../shared/AUTHORING.md),
[`../shared/SUBAGENT_PROTOCOL.md`](../shared/SUBAGENT_PROTOCOL.md), and
[`../shared/EXPLORATION.md`](../shared/EXPLORATION.md). Read them before auditing â€”
each check below points at the rule it enforces.

When invoked from `mpx skill-create`, pass the single skill path as `the invocation input`.

## Step 1: Discover Skills

Glob for `skills/*/SKILL.md`.

If `the invocation input` is a skill name or path, audit only that skill.

## Step 2: Run Checks (per skill)

Spawn parallel `general-purpose` sub-agents with `mode<configured-path>"appropriate runtime class"`, each auditing 3-5 skills. `general-purpose` declares no model of its own, so the parameter is load-bearing here â€” see [../shared/SUBAGENT_PROTOCOL.md](../shared/SUBAGENT_PROTOCOL.md) Â§ 1.

Each agent runs all 16 checks against each skill and returns findings. Checks 12 and 14 run once repo-wide, in the main session.

### Check 1: Positive Instructions

Scan for negative phrasing pattern<configured-path>"do not", "don't", "never", "must not", "cannot", "avoid".

For each match, evaluat<configured-path>is there a clear positive reframing? If yes â†’ auto-fix. If the negative guards against an irreversible or genuinely surprising constraint â†’ keep it and note as acceptable.

### Check 2: SKILL.md Line Count

Run `wc -l <skill>/SKILL.md`. Flag if over 200. Suggest content to move to REFERENCE.md.

### Check 3: Frontmatter Completeness

Required field<configured-path>name`, `description`, `allowed-tools`, `metadata.author`, `metadata.version`, `metadata.category`.

Valid categorie<configured-path>planning`, `execution`, `project-management`, `issue-management`, `git-workflow`, `code-quality`, `code-review`, `refactor`, `testing`, `design`, `setup`, `utility`, `obsidian`.

Flag missing or invalid fields. Auto-fix category casing.

### Check 4: Description Budget and Discoverability

`description` and `when_to_use` are the only parts of a skill that sit in every
session's context. Flag each o<configured-path>- **4a** â€” `description` longer than two sentences, or carrying an inline
  `Use whe<configured-path>"..."` trigger list. Triggers move to `when_to_use`.
- **4b** â€” `when_to_use` longer than three short sentences.
- **4c** â€” combined `description` + `when_to_use` over 1,536 chars, the point at which
  the listing truncates.
- **4d** â€” a model-invocable skill (no `disable-model-invocatio<configured-path>true`) that reads as
  explicit-invocation-only. Ask whether runtime ever needs to reach for it unprompted; if
  not, setting the flag drops its context cost to zero.
- **4e** â€” `when_to_use` present on a skill that has `disable-model-invocatio<configured-path>true`.
  Nothing reads it there; remove it.

### Check 5: Legacy Documentation References

Scan fo<configured-path>REQUIREMENTS.md`, `VOCABULARY.md`, `ARCHITECTURE.md`, `legacy`, `(legacy)`, `fall back`.

Flag any references to the old documentation system. Auto-fix by replacing with CONTEXT.md/DECISIONS.md equivalents.

### Check 6: Explicit Tool References

If skill uses `Agent` in allowed-tools, verify the body names exact agent types.

If skill uses `provider operation`, verify exact `gh` commands are shown.

Flag implicit or missing tool references.

### Check 7: Vocabulary Confirmation Rule

Applies only to skills that write to `.mpx/CONTEXT.md` Â§ Domain Language.

Verify the skill requires user confirmation with full proposed text before writing terms. Flag if missing.

### Check 8: Description Matches Behavior

Compare the `description` field to the skill body. Flag if the description claims capabilities the body doesn't implement, or if the body does things the description doesn't mention.

### Check 9: Spawned Agent Types Exist

For skills with `Agent` in `allowed-tools`: grep the body for spawned agent type names (`grep -oE 'mp-[a-z0-9-]+' SKILL.md` plus explicitly named types like `general-purpose`). Each spawned type must match a file `agents/<type>.md` or a built-i<configured-path>general-purpose`, `Explore`, `Plan`, `runtime`, `runtime-code-guide`, `statusline-setup`. Flag unknown types.

Also flag every spawn instruction that names no agent type at all ("spawn a sub-agent toâ€¦") â€” the type is what determines tools and model, so leaving it implicit is a defect.

### Check 10: allowed-tools Paths Exist

Extract path-like tokens from `allowed-tools` entries (containing `/` or ending in `.sh`, `.js`, `.ps1`, `.md`). Resolve `$HOME/.runtime/` to the repo root, strip glob wildcards, Glob each remaining path. Flag entries whose file is missing on disk.

### Check 11: Dead allowed-tools Grants

For each `allowed-tools` entry, grep the skill body for its usage toke<configured-path>plain tool grants (`Write`, `AskUserQuestion`, `Agent`) â†’ an instruction must actually use that tool; `Bash(<cmd> *)` grants â†’ grep body for `<cmd>`. Flag entries with no matching usage.

### Check 12: README Table Sync

Runs once for the repo. Glob `skills/*/SKILL.md`, `agents/*.md`, `hooks/*` and diff each file list against the corresponding README.md table rows. Flag rows whose file is gone, files on disk with no row, and renamed entries (row and file differ by name only). Report only â€” README edits stay manual.

### Check 13: Model Specification

Rules and evidenc<configured-path>../shared/SUBAGENT_PROTOCOL.md](../shared/SUBAGENT_PROTOCOL.md) Â§Â§ 1 and 7. Only a real `model` parameter selects a model; prose is measured at 0% obeyed, and `effort` is not a call-site parameter at all. Four distinct defect<configured-path>**13a â€” Prose model mention (no-op).** Grep the body case-insensitively for `appropriate runtime class`, `appropriate runtime class`, `appropriate runtime class`, `fable`. Flag every occurrence that sits in an English sentence rather than in a `mode<configured-path>field â€” `Spawn a appropriate runtime class sub-agent`, `(appropriate runtime class)`, `10 appropriate runtime class Sub-Agents`, `the appropriate runtime class orchestrator`. Each one reads as an instruction and does nothing.

Fix by deciding which the author mean<configured-path>- the named agent already declares that model â†’ delete the prose annotation
- the agent type declares no model â†’ replace the prose with a real `mode<configured-path>"<value>"` parameter

Prose that describes the *main thread* rather than a spawn ("handle this at the main-agent level") is not a defect.

**13b â€” Redundant `model` parameter.** Flag a `model` parameter passed to an agent type whose `agents/<type>.md` declares its own `model` â€” the call site duplicates the declaration and drifts when the agent changes.

**13c â€” Missing `model` parameter.** Flag a spawn of `general-purpose`, `runtime`, `Plan`, or `fork` with no `model` parameter. These declare no model, so they inherit the main conversation's model â€” the most expensive option. State the intended model explicitly. Also flag `mode<configured-path>"fable"` â€” only `appropriate runtime class`, `appropriate runtime class` and `appropriate runtime class` are permitted.

**13d â€” `effort` passed to the `Agent` tool.** The tool takes `description`, `isolation`, `model`, `prompt`, `subagent_type` and nothing else, so an `effor<configured-path>at a call site is inert text that reads as an instruction â€” the same defect as 13a. Flag it and delete it. Effort is a frontmatter-only leve<configured-path>a spawn that genuinely needs a non-default effort has to be a real `mp-*` agent with `effor<configured-path>pinned in its own frontmatter, not a `general-purpose` or `runtime` call site. Where the call site only wants to nudge depth, say so in the prompt text instead ("keep the analysis brief â€” this is a scan").

### Check 14: Shared Reference Integrity

Runs once for the repo. For every markdown link to `../shared/<FILE>.md` in any `skills/*/SKILL.md` or supporting file, resolve the path and confirm the target exists. Flag broken links.

Also flag content duplicated from `skills/shared/` â€” a skill restating rules from `SUBAGENT_PROTOCOL.md`, `EXPLORATION.md`, or `AUTHORING.md` instead of linking to them. Shared rules drift the moment they are copied.

### Check 15: Exploration Delegation

Rul<configured-path>../shared/EXPLORATION.md](../shared/EXPLORATION.md) Â§ Delegate.

Flag main-thread instructions that sweep the codebase â€” `Grep`, `Glob`, `rg`, `find`, "search the codebase", "locate", "scan the repo" â€” where the search is broad enough to belong in an `Explore` sub-agent. Reading two or three already-known files is not exploration; a repo-wide content search is.

Two exemptions, both narro<configured-path>a deterministic inventory of a fixed, known path pattern (`Glob skills/*/SKILL.md`), and a search instruction that already sits **inside** a sub-agent prompt.

Also flag delegated searches that state no breadth â€” `Explore` maps `quick` / `medium` / `very thorough` to concrete stopping criteria in its body, so one of them belongs in every spawn. Breadth is search scope, not the `effor<configured-path>reasoning knob.

### Check 16: Hardcoded Personal Paths

Rul<configured-path>../shared/AUTHORING.md](../shared/AUTHORING.md) Â§ Paths.

The repo is public. Search every file in the skill — SKILL.md, references, scripts, and sample HTML — for machine-specific absolute paths, configured workstation roots written literally, and the machine owner's username. Flag each hit and name the `MPX_*` variable that replaces it. Example paths in sample content coun<configured-path>a username in a mockup's `fil<configured-path>link leaks as much as one in an output path.

Also flag, in script<configured-path>a home directory built from a literal instead of `os.homedir()` / `$HOME` / `$env:USERPROFILE`; and a root-resolution fallback that lands on the current working directory rather than failing with a message naming the missing variable.

The only exemptions are `.`, paths relative to the configured project root, and genuine operating-system paths described symbolically.

## Step 3: Auto-Fix

Apply fixes for mechanical issue<configured-path>- Reframe negative instructions to positive equivalents
- Add missing frontmatter fields with sensible defaults
- Replace legacy doc references with CONTEXT.md/DECISIONS.md
- Fix category casing

Bump `version` patch number for each skill that gets auto-fixed.

## Step 4: Report

Output a summary tabl<configured-path>Skill                  | Issues | Auto-fixed | Remaining
-----------------------|--------|------------|----------
grill               |      2 |          2 |         0
to-epic             |      1 |          0 |         1
...
```

Then list remaining issues that need human attention, grouped by skil<configured-path>to-epi<configured-path>- [Check 8] Description says "from passed requirements" but skill reads CONTEXT.md
```

## Rules

- Read each SKILL.md fully before checking â€” partial reads cause false positives
- Verify auto-fixes preserve the original intent
- Bump version only once per skill, even if multiple fixes applied
