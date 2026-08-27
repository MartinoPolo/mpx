# Phase F acceptance status

Phase F is **complete** and the Phase F2 host-Pi/sandbox-executor production split is implemented. Live sbx VM/auth attestation remains an installation gate; later phases remain pending.

## Present in this slice

- runnable Claude and Pi launch integration over immutable v2 descriptors and runtime-context v1;
- separate logical skill artifacts and launch-bound full published-projection references;
- exact four-state exposure behavior, including policy-bound project skills and separate model-versus-human discovery;
- exact executor-evidence recheck before spawn, hardened audit output paths, and restart-on-change semantics;
- Claude guards at `SessionStart`, `UserPromptSubmit`, and `PreToolUse Skill|Agent|Task|Bash`, without claiming atomic native skill-read interposition;
- Pi exact open-handle/body-hash checks and Claude live `StatusSnapshotV1` status refresh;
- shared dangerous-command policy across adapters;
- consumption of preprovisioned read-only private routes/MCP descriptors without creating, installing, copying, or migrating them; Claude MCP support is present, while Pi MCP compatibility remains structured unsupported; KanbanFlow authorization remains in the OS keyring;
- interactive runtimes without an artificial 120-second lifetime, while finite probes remain bounded;
- gated Docker execution with no host fallback while F2 evidence is unavailable;
- explicit direct-TTY host approval; and
- generated Pi-agent, active-identity/path, private-state, provenance, and lockfile validation.

## Required verification

Run, in order where listed by the Phase F integration task:

```bash
pnpm install
pnpm run build
pnpm run check
pnpm run typecheck
pnpm test
pnpm run validate:generated
git diff --check
```

`pnpm run typecheck` is a required pre-commit gate. The repository uses only the root `pnpm-lock.yaml`; nested package-manager lockfiles fail validation.

## Phase F2 routing and proof

The host-Pi/sandbox-executor split is documented in [`PHASE_F2_PROOF_FOUNDATION.md`](PHASE_F2_PROOF_FOUNDATION.md). Production remote routing, exact tool replacement, launch/identity binding, child narrowing and fake-worker proof are implemented without performing live sandbox or authentication operations. F2 launch acceptance now also gates on the CLI-owned launch-private bridge suites: `packages/executors/src/launch-private-bridge.test.ts`, `runtimes/pi/runtime-pi/test/launch-private-client.test.ts`, and `apps/cli/src/fake-pi-bridge.e2e.test.ts`. These prove actual Pi invocation-plan propagation, fake sbx-worker routing, peer/nonce/hash attestation, identity/replay/stale/absence denial, bounded timeout/cancellation, restrictive private state, and awaited process-failure cleanup.

## Supplemental Phase F1 native inventory

The privacy-safe native package/plugin inventory collector, repository declarations, fixture coverage, and redacted execution evidence are documented in [PHASE_F1_NATIVE_INVENTORY.md](PHASE_F1_NATIVE_INVENTORY.md). The current evidence records an unavailable user identity config and therefore makes no live parity claim; collection remains an exact manual gate rather than a reason to scan for account roots.

## Explicit non-claims

This slice does not claim live Docker VM/auth attestation, Phase G session continuation/resurrection, Phase I installation/cutover, or Phase J legacy retirement. A passing integration slice must not be interpreted as acceptance of those phases.
