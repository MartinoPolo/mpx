# Phase H host lifecycle acceptance

Date: 2026-08-26

## Scope and CLI under test

- MPX source HEAD: `977073bf20ebca3d1c8b191abcfc7c24761af2a6`
- CLI rebuilt from that worktree with `pnpm --dir apps/cli build`.
- Every migration command used the exact bundle path `C:/_MP_projects/mpx.worktrees/migration-completion/bin/mpx.mjs` and an explicit `--cwd`.
- No credential operation, cloud mutation, database start, or `docker compose` command was run. The fixed-shared PostgreSQL service was not started.

## Target revisions and assignments

| Target | Accepted revision | Checkout used for project checks | Assigned services |
| --- | --- | --- | --- |
| meeplog | `3f1c7f3eb1c1b49c065ab4c3e62f089046a690df` | `C:/_MP_projects/meeplog.worktrees/phase-h-mpx` | app 8206, preview 8207, Storybook 8208, worker 8209, Vitest client 8210, Vitest Storybook 8211 |
| prejemesi | `babed93f30045441eea0f8ec74658ce5b3587e62` | `C:/_MP_projects/prejemesi.worktrees/phase-h-mpx` | app 8305, preview 8306, Storybook 8307, Vitest client 8308, Vitest Storybook 8309, shared database 5432 |
| Grovekeeper | `1693541` (rollout fix over `4131e3065f5203e184dc18661310002bd38aa904`) | `C:/_MP_projects/Grovekeeper.worktrees/phase-h-mpx` | clean disposable main clone: app 8400, preview 8401, Storybook 8402, Vitest client 8403, Vitest Storybook 8404 |
| template-sveltekit | `8cbd74e` (rollout fix over `7403ded3bb90406425166c1be1c18ea907440479`) | `C:/_MP_projects/template-sveltekit.worktrees/phase-h-mpx` | clean disposable main clone: app 8500, preview 8501, Storybook 8502, Vitest client 8503, Vitest Storybook 8504, shared database 5432 |

All four retained target worktrees were clean after verification. Disposable main clones were needed for Grovekeeper and template-sveltekit because their actual Git main checkouts do not yet contain `mpxconfig.json`; linked reservation correctly failed with `PORT_MAIN_RESERVATION_REQUIRED`. The disposable leases were released and clones removed.

## Lifecycle command evidence and harness boundary

For each configured long-lived app, preview, Storybook, and meeplog worker service, the following bundle commands were issued where a lease was available:

```text
node <exact-bundle> --json --cwd <checkout> dev start --id <service>
node <exact-bundle> --json --cwd <checkout> dev status --id <service>
node <exact-bundle> --json --cwd <checkout> dev logs --id <service> --lines 20|30|40
node <exact-bundle> --json --cwd <checkout> dev restart --id <service>
node <exact-bundle> --json --cwd <checkout> dev status --id <service>
node <exact-bundle> --json --cwd <checkout> dev stop --id <service>
```

Observed startup logs used the assigned URLs, including meeplog app `http://localhost:8206/`, worker explorer/listener 8209, prejemesi app `http://127.0.0.1:8305/`, prejemesi Storybook `http://localhost:8307/`, Grovekeeper app 8400 after its rollout fix, template app `http://localhost:8500/`, and template Storybook 8502. Durable snapshots recorded `readyAt`/`readyPorts` for these listeners before the next invocation reconciled them.

The Pi bash harness places each invoked CLI process in an outer Windows Job Object and closes that job when the CLI invocation returns. Consequently, the harness kills the CLI-owned supervisor and nested framework listener between separate `start` and `status` invocations. Status then correctly reports `crashed` with `Owned process is absent or its fingerprint no longer matches.` This prevents a truthful claim that cross-invocation host lifecycle acceptance passed in this harness; direct URL requests after `start` also encounter the already-cleaned listener. `restart` repeated startup, but the same outer cleanup occurred.

The implementation was therefore also exercised without an intervening CLI-process teardown via the direct nested Job Object integration:

```text
pnpm --dir packages/dev-services exec vitest run src/dev-services.test.ts \
  -t "keeps an immediate nested launcher exit under a durable Windows supervisor" --reporter=verbose
```

Result: **passed** (1 passed, 23 skipped, 4.13 s). It started a top → middle → detached leaf process chain, observed the nested listener/log, reloaded durable state through a fresh manager, stopped the exact surviving listener tree, and proved the port closed. The full MPX test run repeated this integration successfully.

After all attempts, `Get-NetTCPConnection -State Listen` found no listener on 8206–8211, 8305–8309, 8400–8404, or 8500–8504. Thus there were no orphan Phase H listeners.

## Rollout defects fixed in target repositories

Two genuine target rollout defects were found and committed separately; MPX source was not changed for them.

1. Grovekeeper `1693541 fix(dev): accept MPX service URL assignments`
   - RED: added a focused test proving the MPX-injected `http://localhost:<port>` value was rejected by the numeric-only parser.
   - GREEN: the strict parser now accepts the MPX service URL and extracts its explicit localhost port while retaining numeric compatibility.
   - Verification: focused Vitest file passed (3 tests); later Grovekeeper typecheck/test/build/E2E passed.
2. template-sveltekit `8cbd74e fix(dev): launch package tools on Windows`
   - RED: added a focused test for a Windows command-interpreter invocation; the export did not exist.
   - GREEN: controlled package-tool argv now runs through `ComSpec` on Windows instead of directly spawning `pnpm.cmd`, which failed with `spawn EINVAL` under Node 24.
   - Verification: focused Vitest file passed (5 tests); later template check/test/build/E2E passed.

## Target command results

| Target | Commands | Result |
| --- | --- | --- |
| meeplog | `pnpm check`; `pnpm test`; `pnpm build`; `pnpm test:e2e` | PASS; config tests 3/3, E2E readiness 1/1 |
| prejemesi | `pnpm check`; `pnpm test -- --run`; `pnpm build`; `pnpm test:e2e` | PASS; E2E 116 passed with one test flaky on first attempt and passing retry |
| Grovekeeper | `pnpm typecheck`; `pnpm test -- --run`; `pnpm build`; `pnpm e2e` | PASS; E2E 52/52 |
| template-sveltekit | `pnpm check`; `pnpm test -- --run`; `pnpm build`; `pnpm test:e2e` | PASS; unit 198/198, E2E 1/1 |

The target E2E web servers and Playwright readiness checks passed on their configured strict assignments. No cloud or database service was started.

## yoursafe-components blocker

`C:/_MP_work/yoursafe-components.worktrees/phase-h-mpx` is at `8623f134601f2213beb26ec9244771264fa2593a`. Its lease is absent. Running:

```text
node C:/_MP_projects/mpx.worktrees/migration-completion/bin/mpx.mjs --json \
  --cwd C:/_MP_work/yoursafe-components.worktrees/phase-h-mpx ports ensure
```

returns `PORT_MAIN_RESERVATION_REQUIRED: Reserve ports in the current Git main worktree before reserving a linked worktree.` The actual main checkout is reserved/dirty with unrelated work (`.mpx/kanbanflow.json` staged and `AGENTS.md` modified) and does not expose the Phase H manifest at its current commit, so it was not modified. Yoursafe lifecycle acceptance remains explicitly blocked on safely placing/reserving the rollout configuration in the main checkout.

## MPX verification

- `pnpm --dir apps/cli build` — PASS; rebuilt `apps/cli/dist/main.js` and `bin/mpx.mjs`.
- focused direct nested Windows Job Object integration — PASS.
- `pnpm test` from the MPX migration worktree — PASS, including 27 dev-services tests and the nested Windows listener-tree integration.

## Acceptance conclusion

Target port coupling, project checks/builds/E2E, target rollout fixes, direct nested process ownership, and orphan cleanup are evidenced. Cross-invocation `mpx dev` host lifecycle and coupled live URL probes remain **harness-blocked**, not accepted: the Pi harness destroys the supervisor's outer Job Object after each CLI invocation. Yoursafe remains independently blocked by the required main-worktree reservation.
