# Phase F acceptance status

Phase F is **complete**. The final Phase F gates pass, and the spec, security, reliability, and performance reviews are clean. This document records the completed integration slice and its verification boundary; Phase F2 and all later phases remain pending.

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

## Explicit non-claims

This slice does not establish F2 Docker/container isolation, Phase I route/MCP provisioning or installation/cutover, or Phase J legacy retirement. Phase G session continuation/resume is supplied by lifecycle/session components outside this Phase F projection slice. A passing integration slice must not be interpreted as acceptance of the remaining phases.
