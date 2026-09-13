# Checkout-local Orca aggregate-hook candidate

Date: 2026-09-13. Preparation/testing approved; installation and deployment are not.

## Ownership and source

`patches/orca-pi-aggregate.patch` modifies a disposable copy of the existing Orca sender. MPX2 supplies
activity through its public bus, not another HTTP client, registry, daemon or notification mechanism.
`migration/prepare-orca-aggregate.mjs` generates the patch with unique source anchors. Original hook:
`C:/Users/snapy/.pi/agent/extensions/orca-agent-status.ts`, SHA-256
`d3b2c18205406172502f10255875ce7e74012ea2b63b89ec0c54b885e6f11b4d`.
Orca source inspected read-only at `729491597f33031089148bc2fba41a99e0b95de7`.
Neither original source nor installed registration was changed. The existing pi-subagents patch remains
limited to selected-pack discovery/preloading; no additional upstream modification was made.

## Aggregate semantics

- Count queued/started children. Reserve `subagent-result:<id>` before removing a completed child.
- Release on actual individual/grouped native `subagent-notification` message delivery, or documented
  read-only manager `getRecord(id).resultConsumed` after native Agent/get-result tool results or consume RPC.
  No timer or polling guesses completion; missing native result state conservatively holds and warns.
- Native settled clears native queued-input accounting, including follow-ups processed within one loop.
  Named background/follow-up reservations remain independent. The short settling window only coalesces UI.
- Cancellation remains sticky through automatic continuations. A fresh explicit native prompt clears it;
  an aborted first turn does not initiate a new automatic title request.
- Idempotent mutators and terminal handling prevent duplicate completion/reservation. A restart acquires
  child ownership before releasing its prior reservation.
- Native session ID, ephemeral activation ID, monotonic revision and a request handshake protect the
  consumer across registration order/reload. Old title promises cannot clear a replacement activation.
- Hook keeps its original single-writer transport and captures queued session metadata correctly.

## Native probe

Run under a bounded process invocation (60 seconds in the final run; observed duration 33.4 seconds,
including before/after source integrity scans):

```bash
node --import tsx migration/orca-aggregate-probe.mjs \
  C:/Users/snapy/.pi/agent/extensions/orca-agent-status.ts \
  C:/_MP_github_cloned/orca
```

Actual Pi 0.85.1 native loader/session plus unchanged pi-subagents 0.19 manager/RPC/child runner and
native get-result tool loop. Disposable HOME/account/project, in-memory fixture credentials; model
streaming, the nudge clock and hook HTTP delivery are controlled boundaries. Socket connections are
rejected. Observed stream calls: seven, all `mpx-fixture/model`, reasoning `high` (two native child calls,
five parent calls). These are **not authenticated provider calls**.

Passing observations:

1. Parent ends while a real native child is held: no completion post.
2. Child finishes; the actual upstream 200 ms nudge is withheld beyond 700 ms: aggregate still owns its
   pending result, with no premature completion. Releasing that nudge executes the real native follow-up.
3. A second real child is awaited with native `get_subagent_result`: its native consumed flag releases the
   reservation and suppresses the notification, without an extra completion.
4. Public background/question events hold working/human-needed status. These are package-event fixtures,
   not physical question UI.
5. Actual native abort produces `interrupted:true`, not successful completion in the candidate payload.
6. Actual native `session.reload()` replaces the extension runtime, rejects stale prior activity, and
   the replacement hook observes another background-work/completion cycle. This is not proof of every
   live reload scenario with active children.

Four non-cancelled aggregate completions across the exercised work sequences; zero network requests or
installed changes. Original hook bytes match before/after. Focused UI tests pass 22/22; full repository
gate passes 225/225, typecheck, and build (386 projections, zero drift).

Initial probe assumptions were corrected before counting success: RPC background behavior is explicit;
Pi SDK `tools: []` excludes extension tools rather than merely disabling builtins, so the native result
probe explicitly allows `get_subagent_result`. The failed missing-tool run correctly remained pending;
it was not counted as consumption evidence. Additional parent regressions cover native queued input,
duplicate terminal delivery, preparation work, and cancellation before title generation.

## Review and source preservation

The probes explicitly execute read-only external-source dependencies (retained legacy modules and Orca
normalizer), not copied versions of every dependency. `migration/source-integrity.mjs` wraps the entire
execution and checks Git-visible tracked/untracked source bytes, source/index state and explicit files
on success **and failure**, preserving both execution and integrity errors. Bounds are 30,000 entries
per repository, 256 MiB overall and bounded Git commands. The Orca checkout has 25,363 tracked files;
an initial smaller count bound refused the probe before execution and was adjusted explicitly. Ignored
caches and account stores are not scanned; this is not an OS sandbox or a guarantee against arbitrary
malicious code. The final probes passed these checks. Two regressions cover failure preservation and
untracked-byte mutation despite unchanged dirty-entry counts.

A reviewer warning about reusing a shutdown hook instance was not accepted as a native lifecycle defect:
Pi 0.85.1 `agent-session.js:2217–2238` invalidates the old runner, reloads resources and constructs/rebinds
the replacement. The actual reload probe now also proves the replacement listener receives fresh work.
Implementation transcripts identify `openai-codex/gpt-5.6-sol`; review transcripts identify
`openai-codex/gpt-5.6-terra`. High thinking was requested, but their actual thinking levels were not exposed;
the native fixture stream metadata above is separate and directly observed.

## Open gate — receiver approval required

The unchanged Orca `normalizePiCompatibleEvent` was invoked directly with the captured cancellation
payload. It **drops `interrupted`**, so hook-only deployment cannot reliably suppress completion alerts.
A separate checkout-local receiver patch was requested and remains unapproved/unimplemented. Do not
install this hook candidate, claim notification/cancellation acceptance, or silently choose a second
transport to bypass that ownership boundary.

Authenticated workflows, physical Orca attention, manual question/title/footer behavior, installed
registration, real resumed startup and reboot remain separate human/live acceptance gates.
