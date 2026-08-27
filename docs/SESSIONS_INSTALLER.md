# Session lifecycle and scheduled capture

MPX lifecycle events remain authoritative for sessions they represent. Production reconcile also reads the maintained Pi v2 `agent-resurrect/active-sessions` registry under each exact configured and enrolled Pi account root so an active process missed before lifecycle startup can be reconciled. It never scans a home directory. Registry entries are bounded, root-contained, regular files and are admitted only when the PID start fingerprint is exact; foreign-root and stale/reused processes are denied. Legacy saves outside that exact active registry remain available only through the explicit, confirmation-bound import.

Pi native bindings are account-unenrolled unless the host injects an account-binding enrollment resolver. A verifier does not enroll an account. Both active discovery and resume therefore fail closed when the recorded enrollment is absent; resume additionally requires current verification and fails on unavailable, mismatched, or duplicate verification.

Scheduled session capture requires an `ImmutableRunnerAuthority` attesting trusted installed runner evidence for planning, applying, and verification. The production context intentionally provides no such authority until Phase I, so `install plan` and `install apply` return `INSTALL_RUNNER_UNAVAILABLE` rather than scheduling a mutable path.
