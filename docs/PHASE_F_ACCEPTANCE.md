# Phase F acceptance status

Phase F is **not marked complete**. This document defines the current integration slice and its verification boundary.

## Present in this slice

- runnable Claude and Pi launch integration over immutable v2 descriptors and runtime-context v1;
- one runtime-neutral resolved-skill manifest v4 with distinct immutable runtime projections;
- exact four-state exposure behavior and separate model-versus-human discovery;
- private native roots/routes kept out of public descriptors, output, banners, and audit projections;
- alias expansion limited to runtime plus explicit identity;
- Docker gate with no host fallback while F2 evidence is unavailable;
- explicit direct-TTY host approval and restart-on-change semantics;
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

This slice does not establish F2 Docker/container isolation, Phase G session continuation, Phase I installation/cutover, or Phase J legacy retirement. A passing integration slice must not be interpreted as acceptance of those phases.
