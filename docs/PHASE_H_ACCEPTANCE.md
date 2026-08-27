# Phase H host lifecycle acceptance

Date: 2026-08-26

## Scope and safety boundary

Phase H was evaluated with the rebuilt MPX CLI from the migration-completion worktree and explicit target checkouts. No credential operation or cloud mutation was performed. No database service was started by this acceptance work.

Prejemesi's load coverage still depends on Turnstile and its existing database; those external prerequisites are noted rather than claimed as newly provisioned or mutated.

## Final accepted target revisions

| Target | Accepted revision | Final result |
| --- | --- | --- |
| yoursafe-components | `81b12db` | PASS: 550 tests, build, disposable canonical-main and linked-worktree MPX acceptance, HTTPS, and Playwright 278/278 in each checkout |
| meeplog | `3f1c7f3` | PASS: checks, tests, build, and E2E |
| prejemesi | `babed93` | PASS: checks, tests, build, and E2E; load prerequisites noted below |
| Grovekeeper | `1693541` | PASS: typecheck, tests, build, and E2E |
| template-sveltekit | `8cbd74e` | PASS: checks, tests, build, and E2E |

All target worktrees were clean after final verification.

## Port allocation and lifecycle evidence

The configured assignments remained isolated by target:

- yoursafe-components disposable main: Components 8100, Docs 8101
- yoursafe-components linked worktree: Components 8102, Docs 8103
- meeplog: app 8206, preview 8207, Storybook 8208, worker 8209, Vitest client 8210, Vitest Storybook 8211
- prejemesi: app 8305, preview 8306, Storybook 8307, Vitest client 8308, Vitest Storybook 8309, shared database 5432
- Grovekeeper: app 8400, preview 8401, Storybook 8402, Vitest client 8403, Vitest Storybook 8404
- template-sveltekit: app 8500, preview 8501, Storybook 8502, Vitest client 8503, Vitest Storybook 8504, shared database 5432

Yoursafe's stale blocker is resolved at `81b12db`. A clean disposable canonical-main checkout received 8100/8101, and its linked MPX worktree received 8102/8103. Both services used their assigned HTTPS URLs. The target's 550-test suite and build passed, and Playwright passed all 278 tests in the disposable main checkout and all 278 tests in the linked checkout. Cleanup released the allocations and removed the disposable worktree state. Final listener inspection found no orphan listener on 8100-8103.

The other accepted targets retained their previously verified strict assignments and command results:

| Target | Commands | Result |
| --- | --- | --- |
| meeplog | `pnpm check`; `pnpm test`; `pnpm build`; `pnpm test:e2e` | PASS; config tests 3/3, E2E readiness 1/1 |
| prejemesi | `pnpm check`; `pnpm test -- --run`; `pnpm build`; `pnpm test:e2e` | PASS; E2E 116 passed, with one first-attempt flake passing on retry |
| Grovekeeper | `pnpm typecheck`; `pnpm test -- --run`; `pnpm build`; `pnpm e2e` | PASS; E2E 52/52 |
| template-sveltekit | `pnpm check`; `pnpm test -- --run`; `pnpm build`; `pnpm test:e2e` | PASS; unit 198/198, E2E 1/1 |

Final listener inventories found no orphan Phase H listeners across the assigned target ranges.

## Windows supervision and harness boundary

The Pi harness places an invoked CLI process in an outer Windows Job Object and closes that job when the invocation returns. In runs that split `start` and `status` across separate Pi invocations, this can terminate the CLI-owned supervisor and framework listener before the next invocation. Those runs do not provide evidence of cross-invocation persistence and are not represented as such.

The implementation-level supervision behavior was verified directly instead. The nested Windows Job Object integration passed: it kept an immediate nested launcher exit under a durable supervisor, observed the nested listener and logs, reloaded durable state, stopped the exact surviving process tree, and proved that the port closed. The complete no-orphan tests also passed. Together with the target cleanup inventories, this is the Phase H implementation-gate evidence for direct nested supervision and process ownership.

This document does **not** claim live F2 acceptance. It records the implementation gate, target integration results, and bounded harness limitation only.

## Target rollout fixes retained

- Grovekeeper `1693541` accepts MPX service URL assignments while retaining numeric-port compatibility. Its focused regression test and full target verification passed.
- template-sveltekit `8cbd74e` launches controlled package tools through the Windows command interpreter where required. Its focused regression test and full target verification passed.
- yoursafe-components `81b12db` includes the target-side rollout corrections needed for MPX HTTPS assignments and Windows launcher behavior; its final unit, build, dual-checkout HTTPS, and Playwright results passed.

## Load and external-service note

No credentials were accessed or changed, and no cloud resource was mutated. Prejemesi load behavior was not promoted to an infrastructure claim: it uses Turnstile and an existing database. Those dependencies were left in place and were not provisioned, reset, or mutated by this acceptance pass.

## Acceptance conclusion

Phase H's implementation gate is evidenced by clean target revisions, strict per-checkout allocation, successful target checks/builds/browser suites, direct nested Windows supervision, passing no-orphan coverage, and clean final listener inventories. Yoursafe is no longer blocked: revision `81b12db` passed 550 tests and build, allocated disposable main 8100/8101 and linked 8102/8103, served HTTPS, and passed Playwright 278/278 in each checkout.

The Pi outer-Job-Object limitation remains a truthful qualification for cross-invocation persistence in affected harness runs. It does not invalidate the direct nested supervision and no-orphan implementation tests, and it is not presented as live F2 evidence.
