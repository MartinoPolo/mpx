# Writing for Agents

Canonical guidance for skills, agents, project instructions, and references. Local artifact and
runtime-neutral rules remain in [AUTHORING.md](AUTHORING.md).

## Context pointers

A context pointer says what external material does and names each genuinely distinct trigger that
should load it. Collapse synonyms, front-load recognizable terms, and remove identity duplicated by
the target. Put every unique trigger in portable description metadata; adapter-only enrichment must
not be the sole copy.

Always-loaded pointers spend context on every turn. Human-selected documents spend cognitive load
instead. Pay context cost only for useful autonomous discovery; use explicit invocation when the
human should remain the index.

## Information hierarchy

Order material by immediacy:

1. steps every run needs;
2. reference every branch needs;
3. precise pointers to branch-specific reference.

Use progressive disclosure by branch. Co-locate a concept's definition, rules, and caveats. Split
when paths need different material or when a real context boundary prevents premature execution;
do not split merely for line count.

## Semantic completion

Each procedural step names the action, scope, and any validation or stop condition. Avoid a
completion sentence that only repeats the imperative. Retain a standalone gate for consequential
false-success risks, irreversible action, explicit approval, allowed partial success, or exhaustive
reconciliation:

`**Gate:** Continue only when <observable condition>.`

The condition must be measurable over the relevant scope.

## Language

Use accurate leading words such as “cache,” “branch,” or “red” as compact anchors. State the
positive target. Keep a negative only for a surprising guardrail and pair it with what to do.
Provider and runtime names belong only where behavior truly differs; otherwise use MPX contracts,
model classes, and canonical identities.

## Publishing pass

1. Keep each rule authoritative in one place and point to it elsewhere.
2. Remove inventories and commands cheaply discoverable from configuration or `--help`.
3. Remove stale exposition and disclose branch-only detail.
4. Apply a no-op test: delete sentences that do not change target-model behavior.
5. Sharpen observable bounds and false-success gates.
6. Validate relative-link closure and scan for legacy provider CLIs, source paths, and runtime
   placeholders.

No-op judgments are model-relative. When uncertain, compare behavior manually instead of applying
an automatic rewrite.
