---
name: grill
description: "Interviews the user about a plan, design, or requirements until the design is settled, then records the decisions in project docs."
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: name-only
---
# Grill

Interview the user relentlessly about every aspect of their plan, design, or requirements until reaching shared understanding. Walk down each branch of the decision tree, resolving dependencies one by one.
Ask directly in the conversation instead of using AskUserQuestion.

## Step 1: Detect Project Docs

Check for `.mpx/` documentation (see `skills/shared/DOCUMENTATION_STRATEGY.md` for format details):

- `.mpx/CONTEXT.md` — project summary, domain language, feature index, constraints
- `.mpx/DECISIONS.md` — settled architectural and design decisions with rationale

If any exist, read them silently as grilling context. Reference their domain language and constraints during the session.
If none exist (or outside a repo), proceed as a pure conversational grill.

## Step 2: Resolve Input

- If `the invocation input` is inline text, use as the grilling subject.
- If `the invocation input` is a topic or plan description, use directly.
- If no arguments, ask the user what to grill.

## Step 3: Grill

Interview relentlessly. For each branch of the decision tre<configured-path>1. Delegate codebase exploration to the `Explore` agent (breadt<configured-path>medium) instead of asking the user — see [EXPLORATION.md](../shared/EXPLORATION.md).
2. **Batch related questions** into thematic groups. Present each group in one round.
3. **Only split into follow-up rounds** when answers to earlier questions would materially change later ones.
4. **Provide a recommended answer** with each question.

For requirements specifically, clarify each on<configured-path>- Ambiguity — vague terms, edge cases, error handling
- Acceptance criteria — what does "done" look like?
- Dependencies — blocks or blocked by other requirements?
- Scope — what's in, what's out?

Continue until every branch is resolved and shared understanding is reached.

## Step 4: Update Project Docs

After grilling concludes, check which docs exist and have relevant updates.
We're trying to keep these files concise and on point, so think twice before adding anything. It should be the most important context and decisions for the project.
If not sure if important enough, ask user.

**CONTEXT.md** — If new terms, features, or constraints emerge<configured-path>- § Domain Languag<configured-path>for each candidate term, show the full proposed entry (`**Term** — One-sentence definition.`) and ask the user whether to add it. Write only confirmed terms.
- § Core Feature<configured-path>update feature index (name + status + epic#)
- § Key Constraint<configured-path>add newly settled constraints
- § Flagged Ambiguitie<configured-path>record any resolved term conflicts

**DECISIONS.md** — If architectural or design decisions were settle<configured-path>- Add entries grouped by domain (Platform, UI, Data, Session)
- Each entr<configured-path>### Title` + `Decide<configured-path>date` + `Wha<configured-path>+ `Wh<configured-path>+ `Rejecte<configured-path>- Only add entries for settled decisions (open questions stay in the conversation until resolved).

## Report

Summarize the grilling sessio<configured-path>key decisions made, requirements clarified, docs updated (if any), and open items remaining.
