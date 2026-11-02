---
name: hitl
description:
  'Re-surfaces everything unresolved that needs the user (questions, to-dos, reviews) from a long
  session in full original context with visual evidence'
argument-hint: '[since <message or time>] [session ID or path]'
triggers:
  surface all open questions; what needs my decision; full questions again
metadata:
  author: MartinoPolo
  version: '1.0'
  category: project-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# HITL

In long sessions with sub-agents, every relay rephrases and shortens open questions and compaction
shortens them again, so the user returns to terse questions they cannot answer. Produce the
opposite: every open item written so someone who never saw the thread can decide it in seconds,
with its evidence at hand.

## 1. Read the originals

- Source: the current session up to the latest user message; with `since`, from that point; with a
  session ID or path, that session. Read only sessions the user names.
- Read the raw native transcript, not the compacted summary; the compaction note names its path.
  Also read files the session wrote for the user: review indexes, question logs, plans, reports.
- For large transcripts, `mpx-explorer` children locate candidates and return verbatim excerpts;
  the parent classifies.

## 2. Collect and reconcile

Collect every question, decision or permission request; step only the user can do; demo or file
offered for review and not yet reviewed; unfulfilled user request; and decision the agent made on
the user's behalf that the user should check. Start from each item's earliest full wording plus
later expansions, never the shortest restatement.

- Drop an item only with evidence: a later answer, rejection or superseding decision. Keep deferred
  items ("later", "show me first") and the open part of partial answers.
- Check to-dos against the current state (files, commits, renders, Issues), not the transcript.
- Re-derive every recommendation from the current state and look at the visual results yourself
  before recommending; a stale or unchecked recommendation is worse than none.

## 3. Prepare visual aid

Every decision that depends on how something looks gets a picture or clip. For a batch of similar
results to check (for example many fixes of one kind), show a few representative examples, the
worst case included, and state how many they stand for; never produce one capture per item.

- Confirm each file exists and shows the current state. When options compare visually and no single
  comparison exists, compose one, stacked and labelled with the option letters.
- The user often reads on a phone through remote control, where a `file:///` link opens only after
  the file was sent with the file-send tool (SendUserFile). Send each image or video the user should
  see and also link it in its item. Keep each file phone-sized (at most 1080 px wide, big labels,
  at most 3 stacked panels; compress first) and within the user's known format preferences.

## 4. Present

Follow the active output style's `# HITL` section; restate every open item in this one message,
never "still open from earlier". Each item:

```markdown
1. 🛑 **Short title:** the question in at most two lines, readable without the thread.
   👉 rec: the pick and its deciding reason.
   - Context, only what the decision needs: where (time code, screen, file), what happens now,
     quoted original wording, a plain explanation of unfamiliar terms.
   - **A.** every option in full with its visible consequence and cost.
   - **B.** …
   🖼️ [still.jpg](file:///…) · 🎬 [clip.mp4](file:///…) · 📄 [notes.md](file:///…)
```

- Every question has a recommendation and every option is written out; never point to a file
  instead of listing the options.
- Media icons mark only evidence links: 🖼️ image, 🎬 video, 📄 document; one evidence line per item,
  no other new icons.
- Decisions the agent already made go in To do as "check", with the evidence.
- End with one FYI line listing items dropped as resolved and the answer that closed each.

Done means every candidate is presented or listed as dropped with evidence, every option is written
out, and every referenced file exists. If the transcript or a file cannot be read,
report the path and error instead of presenting from the summary.
