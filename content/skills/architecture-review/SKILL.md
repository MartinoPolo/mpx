---
name: architecture-review
description: 'Reviews codebase architecture, develops competing deep-module interfaces, and logs the accepted...'
argument-hint: '[scope or architectural concern]'
triggers: architecture review; deep-module analysis; interface design; refactor RFC planning
metadata:
  author: MartinoPolo
  version: '0.9'
  category: planning
  mpx:
    schemaVersion: 1
    contentVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
    capabilities: [delegate, read, search, shell]
---

# Architecture Review

Explore a codebase like an AI would, surface architectural friction, discover opportunities for improving testability,
and propose module-deepening refactors as RFCs logged in the project's tracker. Use `the invocation input` as the
initial scope or concern.

A **deep module** (John Ousterhout, _A Philosophy of Software Design_) has a small interface hiding a large
implementation. Deep modules are more testable, more AI-navigable, and let tests exercise the boundary instead of
internals.

Before starting, read these complete inputs:

1. [deep modules](../shared/deep-modules.md) — deep versus shallow module evaluation.
2. [interface design](../shared/interface-design.md) — interface design rules for testability.
3. [reference](REFERENCE.md) — dependency categories and the Issue template.
4. [provider routing](../shared/PROVIDER_ROUTING.md) and the selected native provider guide — Issue-provider resolution
   and commands.
5. [content paths](../shared/CONTENT_PATHS.md) — absolute runtime-read resolution when projection does not preserve
   these relative locations.

Resolve assets relative to this loaded skill; follow [Content Paths](../shared/CONTENT_PATHS.md) when a tool requires an
absolute path.

## Process

### 1. Explore the codebase

Spawn `mpx-explorer` with very-thorough breadth and the exploration model class to navigate the codebase naturally. Give
it the resolved scope and ask it to stop when it can cite the major architectural clusters, seams, and test boundaries.
Explore organically and note where understanding creates friction:

- Where does understanding one concept require bouncing between many small files?
- Where are modules so shallow that the interface is nearly as complex as the implementation?
- Where have pure functions been extracted only for testability while bugs hide in how they are called?
- Where do tightly coupled modules create integration risk in their seams?
- Which areas are untested or hard to test?

The friction encountered is evidence. Preserve file and symbol citations for each candidate.

### 2. Present candidates

Present a numbered list of deepening opportunities. For each candidate show:

- **Cluster:** modules and concepts involved.
- **Why they are coupled:** shared types, call patterns, and co-ownership of a concept.
- **Dependency category:** one of the four categories in [REFERENCE.md](REFERENCE.md).
- **Test impact:** existing tests that boundary tests would replace.

Ask exactly: **“Which of these would you like to explore?”** Begin interface design only after a candidate is positively
selected.

### 3. User picks a candidate

Continue only after the user unambiguously selects one candidate. If the selection could identify multiple candidates,
ask a focused clarification.

### 4. Frame the problem space

Before delegation, present a user-facing explanation containing:

- constraints any new interface must satisfy;
- dependencies it must rely on;
- a rough illustrative code sketch that grounds the constraints without presenting it as a proposal.

Then proceed immediately to interface design so the user can consider the framing while agents work.

### 5. Design multiple interfaces

Spawn at least three `general-purpose` sub-agents in parallel. By default, inspect the existing runtime profiles,
resolve the advanced design class to a concrete model that is actually available, and pass that resolved value through
the runtime's real `model` argument with medium effort; `model="advanced"` is not an executable model value. Use the
frontier class only when the user explicitly requests that escalation, resolving it through the same profiles. Give
every agent an independent technical brief containing file paths, coupling details, dependency category, and the
complexity to hide. Report resolved model evidence and assign a different constraint to each:

1. **Minimal interface:** aim for one to three entry points.
2. **Flexible interface:** support many use cases and extension.
3. **Common-caller interface:** make the default case trivial.
4. **Ports and adapters, when applicable:** design around cross-boundary dependencies.

Require each design to provide:

1. Interface signature: types, methods, and parameters.
2. Usage example showing caller behavior.
3. Complexity hidden internally.
4. Dependency strategy using [REFERENCE.md](REFERENCE.md).
5. Trade-offs.

Present designs sequentially, compare them in prose, and then make an opinionated recommendation. Propose a hybrid when
it combines compatible strengths; state any new trade-offs introduced by the hybrid.

### 6. User accepts an interface

Continue only after the user explicitly accepts the final interface shape and its trade-offs. Rework or clarify designs
until that acceptance is unambiguous.

### 7. Log the refactor RFC

Resolve `issues.provider` independently from the nearest valid `mpxconfig.json`; do not infer it from repository hosting
or installed tools. Use only the selected provider guide's documented Issue-create operation: a native operation for hosted providers or the Local guide's application entrypoint. Preserve immutable launch identity and
its account-bound environment for every provider operation. If provider routing, identity, capability, or the required
label is unavailable, return an exact manual handoff instead of switching providers or identities.

Create the Issue immediately without a separate draft-review gate:

- title: `refactor: [module description]`;
- body: the complete template in [REFERENCE.md](REFERENCE.md), populated with the accepted design;
- type label: the provider mapping for `refactor`.

Print the Issue reference (URL or provider-native number) and the accepted interface summary.

## Output contract

```markdown
Scope: [resolved scope] Candidates: [count] Selected Candidate: [cluster] Accepted Interface: [name/summary] Dependency
Category: [category] Issue: [URL/number or manual handoff] Evidence: [exploration and runtime-profile translations]
```
