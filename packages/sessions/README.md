# @mpx/sessions

Private, partitioned session records and lifecycle ingestion for MPX.

Production discovery is identity- and runtime-root-bound. Each configured `(domain, identity, runtime, native root digest)` receives a distinct native binding; roots are never inferred from the current directory or shared across identities. Claude discovery runs the trusted absolute `MPX_CLAUDE_EXECUTABLE` with `CLAUDE_CONFIG_DIR` and direct `agents --json` arguments. Pi discovery is lifecycle-owned: validated MPX lifecycle events create and update records. Reading a legacy Pi `agent-resurrect` registry is supported only as an explicit, confirmation-bound one-time import, never as continuous production discovery.

Resume is confirmation-bound and fail-closed. It revalidates the exact configured identity/root, native target, recorded launch axes and current launch policy before process execution. Pi additionally requires root-attested enrollment and live supported OAuth availability verification; both enrollment and live-auth gates are implemented for production launch and resume.

Lifecycle event files are consumed before session reads/reconcile and after a runtime exits. Records retain process `{ pid, startFingerprint }`, full workflow metadata, launch evidence, and opaque native references; transcripts, prompts, credentials, and native roots are not stored in session records.

Legacy Pi imports require explicit per-source identity mappings (for example `pi:<source-path>=work`) plus an exact mapped Pi root. No mapping is inferred from `cwd`, and mixed personal/work sources remain separate partitions.
