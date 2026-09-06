# @mpx/sessions

Private, partitioned session records, bounded native discovery, lifecycle ingestion, resurrection export, and confirmation-bound resume for MPX.

## Supported operations

The public CLI exposes only `mpx session list` and `mpx session resume <id>`. The exact `session resurrect-export` action is an internal executable route and is intentionally omitted from public help.

`session list` first consumes pending lifecycle events, then reconciles the exact configured identity/runtime roots with bounded Claude and Pi scanners. Claude receives the configured root through `CLAUDE_CONFIG_DIR`; Pi reads only the enrolled v2 active registry beneath the configured root. No home-wide scanning occurs. Unavailable or malformed scanners produce bounded normalized diagnostics while existing records remain listable. Returned records are deterministic and never include native roots, scanner output, credentials, prompts, or transcripts.

`session resume` revalidates the exact configured identity, native binding, root digest, account attestation, native session target, immutable launch axes, and current launch policy before execution. Its argv and confirmation digest are plan-bound. Host execution and resurrection require explicit authority; Docker admission remains fail-closed.

Internal resurrection export consumes pending lifecycle events but deliberately does not trigger broad native discovery. It deterministically projects only eligible records with immutable launch evidence.

Lifecycle event files are bounded, schema-validated, binding-scoped, and consumed before retained operations. Existing optional workflow metadata remains parseable for durable-record compatibility, but obsolete capture, inbox, mark, handoff, completion, branching, and legacy-import services are not exposed.
