# Session lifecycle and scheduled capture

MPX lifecycle events are the authoritative Pi liveness source. Normal production reconcile does not read Pi's legacy `agent-resurrect/active-sessions` registry. That registry is accepted only when explicitly supplied to `session reconcile --import-legacy`; importing reads bounded regular files, requires explicit identity/root mapping, revalidates source hashes, and does not mutate the source.

Pi native bindings are account-unenrolled unless the host injects an account-binding enrollment resolver. A verifier does not enroll an account. Pi resume therefore fails closed before launch when enrollment or verification is unavailable, mismatched, or duplicated.

Scheduled session capture requires an `ImmutableRunnerAuthority` attesting trusted installed runner evidence for planning, applying, and verification. The production context intentionally provides no such authority until Phase I, so `install plan` and `install apply` return `INSTALL_RUNNER_UNAVAILABLE` rather than scheduling a mutable path.
