# Phase F rollback and relaunch

Phase F launch artifacts are immutable and content-addressed. Rollback does not edit a running projection or widen a running process. Stop the runtime, restore the previously accepted configuration/content revision and matching artifact set, resolve a new descriptor, then relaunch. A changed launch key, manifest key, artifact key, binding, or executor-verification digest must produce `LAUNCH_RESTART_REQUIRED` rather than an in-process transition.

For a failed launch:

1. retain the safe launch/audit identifiers and error code;
2. stop the child process if it started;
3. do not reuse a consumed host approval;
4. remove only invocation-owned unpublished staging output;
5. preserve content-addressed published artifacts for diagnosis or later garbage collection;
6. correct configuration/content/evidence and create a new launch.

Docker gate failure has no host fallback. Host compatibility requires a new explicit request, reason, trusted elevation approval, and direct-TTY confirmation. Native Claude/Pi credentials, sessions, caches, and account roots are private external state and must not be copied, deleted, or restored by Phase F rollback.

Installer snapshots and cutover reversal belong to Phase I, session restoration to Phase G, and legacy retirement reversal to Phase J. This document does not claim those capabilities or F2 isolation.
