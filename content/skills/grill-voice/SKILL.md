---
name: grill-voice
description:
  'Voice-enabled variant of the grill skill: publishes each interview round as a JSON file for the
  companion...'
metadata:
  author: MartinoPolo
  version: '0.2'
  category: planning
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Grill by Voice

Run the bundled [{{MPX_SKILL_PREFIX}}grill workflow](GRILL_WORKFLOW.md) interview, but exchange each round with the user's mobile
voice app through JSON files instead of conversation. The user is on a walk: questions are spoken to
them, answers come back as Whisper transcripts. The file formats and session lifecycle live in
[CONTRACT.md](CONTRACT.md) — read it before the first round.

All session bookkeeping goes through one script. Resolve assets relative to this loaded skill;
resolve [scripts/grill-voice.js](scripts/grill-voice.js) relative to this loaded skill, and store the
resolved literal absolute path as `GRILL_VOICE_SCRIPT` for the session. Never use a source-repository
path or a runtime-specific skill-root token.

```bash
node "$GRILL_VOICE_SCRIPT" <init|publish|wait|complete> ...
```

## Step 1: Context and subject

Follow the bundled [{{MPX_SKILL_PREFIX}}grill workflow](GRILL_WORKFLOW.md) Steps 1–2: silently read `.mpx/CONTEXT.md` and
`.mpx/DECISIONS.md` when present, and resolve `the invocation input` as the grilling subject (ask
when absent).

## Step 2: Start the session

```bash
node "$GRILL_VOICE_SCRIPT" init --project <name> --topic <topic>
```

Prints the `sessionId` used by every later command. Confirm to the user that the session is live and
they can put the phone in their pocket.

**Fallback to conversational grilling** — when the user says they are at the keyboard, or the script
fails (no Node, unwritable sessions root): continue with {{MPX_SKILL_PREFIX}}grill Step 3 in the conversation and
skip the publish/wait cycle entirely.

## Step 3: Rounds

Compose each round exactly as {{MPX_SKILL_PREFIX}}grill Step 3 prescribes: delegate codebase facts to the named
`mpx-explorer` agent at medium breadth (with no model override), batch related questions
thematically, split into a follow-up round only when earlier answers materially change later
questions, and attach a recommendation to every question.

Voice changes only the delivery:

1. **Write questions for the ear** — short sentences, no markdown or code syntax, identifiers
   spelled out. Include the round `announcement` naming project, topic, and round number so the user
   can tell sessions apart (formats in [CONTRACT.md](CONTRACT.md)).
2. Write the round JSON to the session scratchpad, then publish it:

   ```bash
   node "$GRILL_VOICE_SCRIPT" publish <sessionId> <roundFile>
   ```

3. Wait for the spoken answers:

   ```bash
   node "$GRILL_VOICE_SCRIPT" wait <sessionId> <round>
   ```

   Exit 0 prints the answers JSON. Exit 2 means still waiting — run `wait` again, indefinitely; the
   user answers at walking pace, and each `wait` call polls for several minutes before returning.

4. Treat each `transcript` as the user's answer. Transcripts are speech: read them charitably
   (homophones, spelled-out identifiers) and carry any genuinely ambiguous transcript into the next
   round as a clarification question. A `skipped` question is re-asked once in a later round or
   explicitly dropped with a note in the report.

## Step 4: Conclude

Follow {{MPX_SKILL_PREFIX}}grill Step 4 for `CONTEXT.md` / `DECISIONS.md` updates, with one adaptation: where {{MPX_SKILL_PREFIX}}grill would ask the user whether an uncertain entry belongs in the docs, put those confirmations
into one final voice round instead of asking in conversation. Each confirmation question speaks the
full candidate entry — for a Domain Language term, the term and its complete one-sentence
definition, voice-adapted per [CONTRACT.md](CONTRACT.md) — so the user hears exactly what would be
written before it lands in the docs.

Then close the session so it leaves the app's active list:

```bash
node "$GRILL_VOICE_SCRIPT" complete <sessionId>
```

A successful completion command marks the session completed and removes it from the app's active
list. If it fails, report the error without claiming closure.

## Report

Summarize as {{MPX_SKILL_PREFIX}}grill does — decisions made, requirements clarified, docs updated, open items — and
note anything lost to voice: skipped questions, ambiguous transcripts, and where each was resolved
or dropped.
