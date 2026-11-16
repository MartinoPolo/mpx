Compaction instructions the user gave for this summary take precedence over this guidance.

Write the summary for an agent with zero other context: it is all the continuing agent knows, so it
must be able to continue without re-investigating or asking the user to repeat anything. Keep the
standard summary sections, and put the sections below first because they hold the state that is
otherwise lost. Record each item once: when a standard section already holds it, extend it there
instead of repeating it. Write "None" for an empty In Flight or Open Questions section so the absence
is explicit.

- **Role & Workflow** — this thread's role (for example an orchestrator that only delegates, an
  executor, a reviewer), its delegation rules, the active skills or workflows and the current step in
  each, and the user's workflow instructions verbatim.
- **Standing Instructions** — every user instruction, preference, and constraint that still applies,
  verbatim, with its scope (session, task, file). Carry forward those recorded in any earlier summary
  in the transcript; drop one only when the user superseded it or its task finished, and say which.
- **Open Questions** — questions to the user and approvals still unanswered, verbatim with their
  original numbering, and whether work was paused waiting for the user. They are unanswered: the
  continuing agent must not assume answers or act on them.
- **In Flight** — subagents, background tasks, other sessions, and terminals still running or not yet
  collected: ID or handle, what each was asked to do, what it should return, and where the result
  will appear.
- **Key Decisions** — what was decided and by whom (user or agent), the alternatives rejected, and
  why, including the trade-offs and constraints that forced the choice.
- **Dead Ends & Mistakes** — abandoned approaches and the symptom that killed each (verbatim error,
  wrong assumption), so they are not retried.
- **Working Memory** — constraints carried in the head rather than the code: dependencies between
  components, "don't change X because…", environment quirks, version-specific behaviour.
- **Critical Files** — first the files holding durable state (plans, handoffs, task lists), then
  every file the continuing agent must read or modify: `path` — why it matters.
- **Next Steps** — prioritized, each with the paths, symbols, prerequisites, and ordering needed to
  start immediately.

Accuracy rules:

- Record only what the transcript shows. Mark inferences "(assumption)" and unconfirmed results
  "(unverified)"; never present an agent proposal as a user decision.
- Keep file paths with line numbers, identifiers by their exact names, and error text verbatim.
- Capture the why, not just the what: reasoning survives compaction; bare conclusions get
  re-derived, often wrongly.
- When the transcript begins with an earlier summary, carry forward every item in these sections
  that still holds; anything omitted is lost.
