# Execute Close-out

Close-out begins only after implementation and repository checks pass.

1. Review the complete diff, changed-file list, and status. Preserve pre-existing changes.
2. Map every acceptance criterion to test, check, visual assertion, or explicit unverified/manual evidence.
3. Run the canonical review loop over the complete execution diff. Re-run relevant checks after accepted fixes. Exhaustion after three iterations is reported, not hidden.
4. Update `.mpx/CONTEXT.md`, `.mpx/DECISIONS.md`, README, or operational docs only when the change alters durable domain language, architecture, setup, or user behavior.
5. For changed UI, report each surface and assertion outcome. Visual confidence from inspection alone is not verification.
6. Record manual handoffs, privacy constraints, known risks, and unsupported capabilities.
7. Update or finish the Issue only through launch-bound MPX Issue capabilities and only with evidence. Board writeback moves completed autonomous work to `# Manual testing` with its checkbox unchecked.

Output changed files, acceptance evidence, checks, review findings/fixes, documentation, Issue/board state, and remaining action. Do not create a Review or merge unless separately authorized.
