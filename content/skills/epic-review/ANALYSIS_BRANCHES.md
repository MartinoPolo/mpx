# Epic Review Analysis Branches

Run these alongside code-quality, best-practices, specification, security, performance, and error-handling reviewers.

1. **Architecture:** inspect changed files and confirmed decisions for coupling, shallow modules, misplaced policy, unstable interfaces, and decomposition candidates.
2. **Cleanup:** verify usages before reporting unused exports, stale imports, superseded helpers, duplication, or orphaned fixtures.
3. **Documentation:** inspect existing `.mpx/CONTEXT.md`, `.mpx/DECISIONS.md`, and README for domain, setup, feature, and decision drift. Missing files are out of scope.
4. **Unresolved work:** scan authorized Issue and Review text for deferred, temporary, workaround, skipped, or follow-up work. Verify against current code and the resolved provider reference’s documented native operation with an explicit target. Classify Complete, Already Tracked, Needs AFK Issue, or Needs HITL Issue.

Every branch returns findings as severity, title, location/source, consequence, evidence, and suggested action, or an explicit no-findings result. Unresolved work must identify its source without reproducing private unrelated conversation.
