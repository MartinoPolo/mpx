# @mpx/sessions

Private, partitioned session records and lifecycle ingestion for MPX.

Production discovery is identity- and runtime-root-bound. Each configured `(domain, identity, runtime, native root digest)` receives a distinct native binding; roots are never inferred from the current directory or shared across identities. Claude discovery runs the trusted absolute `MPX_CLAUDE_EXECUTABLE` with `CLAUDE_CONFIG_DIR` and direct `agents --json` arguments. Pi discovery is lifecycle-owned: validated MPX lifecycle events create and update records. Reading a legacy Pi `agent-resurrect` registry is supported only as an explicit, confirmation-bound one-time import, never as continuous production discovery.

## User-authored handoff and completion

`mpx session handoff <id> --identity <name> --summary <text> --next-action <text> --disposition paused|unfinished` records a concise user-authored handoff without invoking a model. `mpx session complete <id> --identity <name> --summary <text> --next-action <text> --disposition completed|paused|unfinished` records the explicit completion disposition; `unfinished` reopens the inbox, while `paused` and `completed` archive it. Both commands return a versioned `session-disposition` observation envelope. Summary and next action are required, NFC-normalized, control-character-free, and limited to 512 characters. Add `--runtime claude|pi` when the same identity has an ambiguous abbreviation.

Retries with the same identity, target, operation, text, and disposition are idempotent, including after restart. Writes remain locked to the recorded identity/runtime partition. These operations update only MPX's private session registry: they never invoke a model, persist prompts/transcripts/native roots/account data, or delete native runtime history. Reconcile observations include workflow status, inbox state, and the latest disposition timestamp for status consumers.

Resume is confirmation-bound and fail-closed. It revalidates the exact configured identity/root, native target, recorded launch axes and current launch policy before process execution. Pi additionally requires root-attested enrollment and live supported OAuth availability verification; both enrollment and live-auth gates are implemented for production launch and resume.

Lifecycle event files are consumed before session reads/reconcile and after a runtime exits. Records retain process `{ pid, startFingerprint }`, full workflow metadata, launch evidence, and opaque native references; transcripts, prompts, credentials, and native roots are not stored in session records.

Legacy Pi imports require explicit per-source identity mappings (for example `pi:<source-path>=work`) plus an exact mapped Pi root. No mapping is inferred from `cwd`, and mixed personal/work sources remain separate partitions.
