---
name: grill
description: 'Interviews the user about a plan, design, or requirements until the design is settled, then records...'
metadata:
  author: MartinoPolo
  version: '2.5'
  category: planning
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: name-only
---

# Grill

Interview the user relentlessly about every aspect of their plan, design, or requirements until reaching shared
understanding. Walk down each branch of the decision tree, resolving dependencies one by one. Ask directly in the
conversation instead of using AskUserQuestion.

## Step 1: Detect Project Docs

Check for `.mpx/` documentation (see [Documentation Strategy](../shared/DOCUMENTATION_STRATEGY.md) for format details).
Resolve this relative link from the compiled content tree; if projection relocates it, follow the runtime
`CONTENT_PATHS` procedure using `MPX_ACTIVE_CONTENT_ROOT` and stop on no match or ambiguity:

- `.mpx/CONTEXT.md` — project summary, domain language, feature index, constraints
- `.mpx/DECISIONS.md` — settled architectural and design decisions with rationale

If any exist, read them silently as grilling context. Reference their domain language and constraints during the
session. If none exist (or outside a repo), proceed as a pure conversational grill.

## Step 2: Resolve Input

- If `the invocation input` is inline text, use as the grilling subject.
- If `the invocation input` is a topic or plan description, use directly.
- If no arguments, ask the user what to grill.

## Step 3: Grill

Interview relentlessly. For each branch of the decision tree:

1. Delegate codebase exploration to the named `mpx-explorer` agent at medium breadth instead of asking the user — see
   [Exploration](../shared/EXPLORATION.md). Give it the subject, scope, exclusions, and stopping condition; use repository evidence for facts and ask the
   user only for product intent or owned trade-offs.
2. **Batch related questions** into thematic groups. Present each group in one round.
3. **Only split into follow-up rounds** when answers to earlier questions would materially change later ones.
4. **Provide a recommended answer** with each question, including the relevant trade-off rather than a bare preference.

For requirements specifically, clarify each one:

- Ambiguity — vague terms, edge cases, error handling
- Acceptance criteria — what does "done" look like?
- Dependencies — blocks or blocked by other requirements?
- Scope — what's in, what's out?

Continue until every branch is resolved and shared understanding is reached.

## Step 4: Update Project Docs

After grilling concludes, check which docs exist and have relevant updates. We're trying to keep these files concise and
on point, so think twice before adding anything. It should be the most important context and decisions for the project.
If not sure if important enough, ask user.

**CONTEXT.md** — If new terms, features, or constraints emerged:

- § Domain Language: for each candidate term, show the full proposed entry (`**Term** — One-sentence definition.`) and
  ask the user whether to add it. Write only confirmed terms.
- § Core Features: update the feature index (name + status + MPX Issue ID).
- § Key Constraints: add newly settled constraints.
- § Flagged Ambiguities: record resolved term conflicts.

**DECISIONS.md** — If architectural or design decisions were settled:

- Add entries grouped by domain (Platform, UI, Data, Session)
- Each entry: `### Title` + `Decided: date` + `What:` + `Why:` + `Rejected:`
- Only add entries for settled decisions (open questions stay in the conversation until resolved).

## Report

Summarize the grilling session: key decisions made, requirements clarified, docs updated (if any), and open items
remaining.
