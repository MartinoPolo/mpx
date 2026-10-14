# Result Line

End the final message of a skill run with one result line, the last line of the message:

- `✅ <skill>: <outcome in a few words> · <link> · <link>` when the run reached its goal.
- `❌ <skill>: <blocker in a few words> · <link>` when it stopped short or needs a human.

Example: `✅ execute: Draft MR !312 created, CI green · <MR URL> · <pipeline URL>`.

Link every deliverable that exists (Issue, PR, CI run, page). Questions and progress updates never
carry a result line, so orchestrators can treat `^(✅|❌) <skill>:` on the last line as the end of
the run.
