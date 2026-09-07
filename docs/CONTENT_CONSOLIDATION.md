# Content consolidation

## Authority and scope

The current user request is to compare the dirty main checkout with `restore-native-content-port`, recover prior
requirements, and consolidate the best version of each skill, agent, support file, shared instruction, and runtime
prompt. Neither checkout is authoritative merely because it is newer or more detailed. Originals are behavioral
evidence, not an instruction to restore obsolete infrastructure.

The latest request leaves replacement of MPX undecided. The extraction plan in main describes a candidate destination
architecture; it does not authorize deleting the current platform or activating a new installation in this task.

Consolidation edits belong in this worktree. Preserve main, original repositories, installed runtime files, credentials,
and sessions. Do not commit, push, install, or activate.

## Recovered evidence

- Session `01a07bf1`, user messages at 2026-09-07T10:01:38Z and 10:52:45Z: compare active originals, retain important
  branches, examples, commands, named agents, supporting documents, and Pi-specific instruction substance.
- Session `01a07bf1`, user messages at 09:09:02Z and 09:09:34Z: normal work uses the current checkout; file count is not
  an isolation trigger.
- Session `01a07bf1`, user message at 14:39:27Z: compare both checkouts item by item, recover requirements with Luna,
  aggressively remove unnecessary tests and complexity, and keep useful content reusable if MPX is abandoned.
- Session `01a07bf2-a62a-737c-affd-e814a5f4bba0`: native provider tools, independent Issue/repository selection, native
  authentication, low-context discovery, one maintained body, preserved native Pi extensions, and a proposed extraction
  without compilation or mandatory launch. The latest request reopens whether to adopt that replacement architecture.
- Main's `docs/SKILLS_EXTRACTION_MIGRATION.md` records the extraction design and explicitly does not authorize
  installation changes or platform deletion.

## Comparison rubric

For every artifact, record `keep main`, `keep worktree`, `combine`, `identical`, or `retire`, with evidence and any
unresolved decision.

1. Preserve meaningful workflow branches, handoffs, results, useful examples, and executable guidance. Remove redundancy
   and stale instructions, not substance to satisfy a size target.
2. Prefer the simplest usable instruction. Do not require worktrees, review loops, CI watching, or delivery for
   unrelated operations. Preserve deliberately invoked end-to-end workflows and their documented opt-outs.
3. Select Issue and repository providers independently from project configuration. Native commands belong in focused
   provider guides; native tools own authentication. Do not invent commands or treat content selection as account
   isolation.
4. Preserve named-agent responsibilities and actual model selection. A prose model-class name is not an implemented
   resolver. Keep runtime packaging separate from reusable workflow semantics.
5. Keep descriptions short and useful. Distinguish low-context discoverability from genuinely explicit-only invocation;
   do not silently change runtime exposure contracts while the destination architecture is undecided.
6. Resolve local support references from the loaded skill, not the target project. Resolve machine roots from supplied
   environment variables. Do not invent path variables or assume Markdown interpolation.
7. Maintain shared meanings once. Prefer a useful shared reference over duplicated rules, but not a chain of
   indirections that obscures the operation.
8. Remove prose snapshots, phrase gates, historical parity fixtures, redundant checks, and tests of intentionally
   retired machinery. Retain focused tests that exercise retained executable behavior, discovery, path safety, and real
   failure boundaries. Do not delete live infrastructure merely to remove its tests.
9. Treat broad runtime/compiler/provider-package changes separately from content consolidation. Record their merits and
   conflicts before selecting them.

## Status

Requirements recovery, per-artifact comparison, and selected content consolidation are complete. This worktree is the
consolidated review source for skills, agents, shared instructions, and runtime prompts. Main remains untouched and is
not an interchangeable content source: it contains separate uncommitted infrastructure simplification work.

The decision tables below record the comparison and selected corrections. Confirmed workflow, command, agent, and path
corrections have been applied. The retained duplication and deployment boundaries are explicitly recorded under
Verification and limits.

## Initial artifact decisions

These are content decisions, not approval to replace platform infrastructure.

#### Artifact: `issue-create`

- **Decision:** Combine, worktree base
- **Remaining consolidation:** Rebuilt corrupted template using intact main structure and body-link rules; named
  explorer and capability wording corrected.

#### Artifact: `issue-view`, `issue-refine`

- **Decision:** Removed from active content by user request; preserved under `deprecated/skills`.
- **Reason:** Migration additions with no original skill counterpart. Provider reads/edits remain available without
  dedicated skill wrappers.

#### Artifact: `bug-report`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Complete guide support for closed-Issue duplicate search; retain current exposure until
  discovery policy is decided.

#### Artifact: `execute`, `batch-execute`, `hitl`, `ship`

- **Decision:** Combine, worktree base
- **Remaining consolidation:** Recover concrete original handoff, state-entry, progress and visual-verification detail
  without restoring obsolete runtime commands.

#### Artifact: `commit`, `commit-push-pr`, `pr`, `review`

- **Decision:** Combine; restore original `pr` identity instead of `review-publish`. User-facing artifacts are PRs
  (GitLab MRs); “review” names the reviewing activity. Internal provider contracts remain unchanged.
- **Remaining consolidation:** Keep compact operations and worktree routing; restore title/body, explicit update
  identity and acceptance evidence where missing.

#### Artifact: `commit-push`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Correct supporting agent remote selection; assess redundant output requirements.

#### Artifact: `epic-create`, `to-issues`, `decompose`

- **Decision:** Keep `epic-create`; restore original `to-issues` identity instead of `epic-decompose`. `decompose`
  remains the separate source-file refactoring skill.
- **Remaining consolidation:** Normalize actual provider commands and agent policy descriptions, not phrasing parity.

#### Artifact: `epic-review`

- **Decision:** Combine, worktree base
- **Remaining consolidation:** Preserve body-link orchestration and support templates; include repository-provider
  limits and concrete Git evidence operations.

#### Artifact: Provider guides

- **Decision:** Combine
- **Remaining consolidation:** Main explicit target/Gerrit guidance plus worktree operational detail; preserve managed
  local Issue interface.

#### Artifact: Shared commit workflow

- **Decision:** Combine
- **Remaining consolidation:** Replace contradictory mandatory typed-facade phases with selected native guides and named
  finder/review-manager handoffs.

#### Artifact: Global and runtime prompts

- **Decision:** Combine after runtime review
- **Remaining consolidation:** Preserve useful rules; keep current packaging separate from extraction proposals.

#### Artifact: Generated CLI references and runtime profiles

- **Decision:** Keep current platform
- **Remaining consolidation:** Do not import main's facade deletion or claim model mappings are absent.

Reviewer findings require verification: canonical agent models are selected through metadata/profiles, and `../shared/`
references are valid in compiled projections even though absent beside source skills. Neither is a defect solely from
reading the Markdown source.

The repaired Issue template and explorer handoff passed focused support-script, reference-closure, and content-safety
tests. After shared-provider consolidation, the complete skills unit suite passed. These tests establish structure and
executable safety, not semantic fidelity.

## Authoring, design, quality, and agent decisions

#### Artifact: `agent-create`, `skill-create`, `skill-audit`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Replace unavailable runtime-guide handoff with existing documentation capabilities;
  verify generic delegation support without adding agent machinery by default.

#### Artifact: `architecture-review`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Preserve deep-module process and reference; clarify selected-provider wording and
  deliberate model escalation.

#### Artifact: `design-brief`, `design-refine`

- **Decision:** Combine
- **Remaining consolidation:** Add main's explicit target and missing-gate authorization to current workflow.

#### Artifact: `design-init`

- **Decision:** Keep worktree
- **Remaining consolidation:** Preserve choices, examples, confirmation, and theme reconciliation.

#### Artifact: `mockup` and variant generator

- **Decision:** Combine contract
- **Remaining consolidation:** Align generator output with the caller's variant filenames and linked tokens; make
  style-specific constraints conditional.

#### Artifact: `check-fix`, `suppression-audit`

- **Decision:** Keep current workflow, repair support
- **Remaining consolidation:** Resolve bundled scripts outside caller checkout; share duplicate detector implementation
  and specify fast/full checks.

#### Artifact: `fallow-fix`, `code-clean`

- **Decision:** Keep worktree
- **Remaining consolidation:** Distinguish incremental feedback from final verification without redundant reruns.

#### Artifact: `components-audit`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Consolidate duplicated rule ownership and reconcile overlapping audit axes.

#### Artifact: Named agents and language references

- **Decision:** Keep current responsibilities, repair interfaces
- **Remaining consolidation:** Correct MCP discovery, explicit targets/remotes, root resolution, Review update identity,
  and flawed language examples. Keep existing metadata/profile model selection.

## Utility and personal-content decisions

#### Artifact: `continue`, `handoff`, `harvest-decisions`

- **Decision:** Keep worktree
- **Remaining consolidation:** Preserve runtime-aware recovery, bounded handoff and authorized session access.

#### Artifact: `grill`, `grill-voice`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Preserve interview branches; replace unverifiable duplicate voice-closure gate with
  actual command outcome.

#### Artifact: `init-github-repo`

- **Decision:** Replace `repository-setup` with a personal GitHub-specific continuation of original `init-repo`.
- **Restored scope:** GitHub creation and push, visibility confirmation, `main`/`dev` branches, `dev` default branch,
  and protection on both branches. The earlier remote-setup retirement was unintended and is superseded.
- **Portability exceptions:** Bundle the original initializer/template; remove machine/runtime fallback paths, preserve
  existing files, and report partial failures. Project registration invokes this workflow for uninitialized projects.

#### Artifact: `setup-react-native`, `setup-sveltekit`, `project-register`

- **Decision:** Combine, worktree base
- **Remaining consolidation:** Retain useful setup/report detail, eliminate invented operations, and make unsupported
  integrations explicit.

#### Artifact: `board-setup`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Scope Git configuration locally and repair newline-safe ignore updates.

#### Artifact: `board-to-issues`, `clean-pc`, `raycast-config`, `symlink`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Repair concrete stale references and contradictions; keep meaningful safety and
  provider-independent behavior.

#### Artifact: `vocabulary`, `notebooklm`

- **Decision:** Identical behavior / keep current
- **Remaining consolidation:** NotebookLM timeout and source-wait consistency still needs repair.

#### Artifact: `podcast`

- **Decision:** Combine, worktree base
- **Remaining consolidation:** Backend-specific authentication, explicit scratch/output handling, source readiness.

#### Artifact: `tutorial-create`, `video-to-image`

- **Decision:** Keep worktree paired implementations
- **Remaining consolidation:** Repair final output-path safety and clarify fallback output contract.

#### Artifact: `playwright-test`, `script-discovery`, `sync-base`, `consolidate-context`

- **Decision:** Keep worktree base
- **Remaining consolidation:** Correct root resolution and concrete retained-script bugs; preserve meaningful workflow
  branches.

All canonical skill identities and named agent definitions received a main/worktree/original comparison. Confirmed
corrections were applied in non-overlapping batches. Runtime loading and test-retirement decisions were reviewed
separately from the content choices.

Shared native guides now include Gerrit, explicit repository/project targeting, closed-Issue lookup and structured
CI/milestone operations. Local Issues retain the existing managed interface. Provider support remains
capability-specific: Gerrit does not supply Issue or CI operations; KanbanFlow does not supply Review, CI, milestone, or
label-creation operations. No platform deletion or native installation change follows from these content choices.

## Verification and limits

Passed after consolidation:

- Skills unit suite: frontmatter, inventory, support syntax, path/reference closure, and safety.
- Content-compiler unit suite and application dependency builds, including both runtime adapters.
- Focused application instruction-loading, Claude/Pi projection and invocation, and media helper tests.
- Pi extension build and focused worktree, guard-trust, and source-boundary tests.
- Formatting and `git diff --check`.

Cleanup removed prose-parity fixtures and wording assertions, a namespace-classification prose gate, redundant
subprocess output-path tests, the duplicate suppression detector, and repeated Pi/global prompt policy. Retained tests
exercise retained functionality rather than historical text. The React directive examples were split into actual module
examples so formatting cannot turn directives into ordinary expressions.

Keep the worktree's managed instruction loading and Claude wrapper projection. Pi appends runtime-specific guidance to
shared policy without repeating that policy. Worktree handoff restores realpath canonicalization; its tool no longer
advertises an unsupported color option. These are source changes, not activated account behavior.

One intentional duplication remains: the shadcn-svelte audit reference and project rule serve different current
projection consumers. Consolidating them safely requires agreeing that consumer boundary; no new loader was added merely
to eliminate a copied reference.

Native commands were checked against installed help and source, not exercised through remote mutations.
GitLab/Gerrit/KanbanFlow capabilities remain as limited by their guides. No end-to-end installed-harness acceptance run
or setup was performed. The extraction plan's naming, discovery, and platform-retirement choices remain undecided in
this task.

No changes were made to main, original repositories, account instructions, credentials, or installed runtime artifacts.
Nothing was committed, pushed, installed, or activated.
