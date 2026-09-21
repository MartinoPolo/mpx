---
name: playwright-test
description:
  'Runs one-time visual acceptance of the latest UI requirements and returns findings with an inspected screenshot gallery.'
metadata:
  author: MartinoPolo
  version: '0.5'
  category: testing
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Visual Acceptance with Playwright

Verify that the finished UI satisfies the latest visual requirements. This skill owns scope and
orchestration; `mpx-visual-verifier` captures and inspects the evidence. This complements persisted
E2E tests and does not create or replace them. Do not fix implementation defects during this skill.

## 1. Resolve scope and requirements

Parse the invocation input:

- `uncommitted` or empty: inspect `git diff --name-only HEAD` and relevant untracked files.
- `review:<id>`: follow [Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md) and the
  selected repository guide to obtain the explicit review's requirements, source revision, and
  changed files. Confirm the checkout being verified matches that revision; stop on ambiguity.
- Otherwise: use the supplied description of the feature and its latest requirements.

Read the agreed requirements and linked design context, then identify changes to rendered
appearance or visually observable interaction. Do not infer expected results solely from the
implementation. Ask about material ambiguity. If no visual changes exist, report the reason and
skip browser work; passing E2E tests is not a reason to skip visual acceptance.

## 2. Prepare the application

Read repository instructions, `package.json`, and referenced configuration for the relevant app,
installed Playwright helper, server command, and approved test-auth setup. Use a supplied URL only
when it serves the intended checkout. Otherwise, if project policy permits, start the documented
local dev or Storybook command, retain its process identity, and verify readiness with a bounded
wait. Do not guess a port, disturb user-owned servers, or install missing tooling automatically.
Report blocked prerequisites rather than claiming successful verification.

The orchestrator owns server preparation and cleanup; the verifier receives a verified URL and
returns server failures to it. Stop only processes started by this invocation on completion or
failure. Never expose credentials or repurpose provider credentials. Supply only approved test-auth
context; authentication should be programmatic unless login itself is the changed feature.

## 3. Delegate visual acceptance

Invoke `mpx-visual-verifier` with the requirements, design constraints, affected routes and states,
checkout identity, verified URL, project runner/auth details, and an untracked task-local artifact
directory. Use its declared model settings; reserve an advanced override for unresolved visual
reasoning, not routine capture. Give it these acceptance expectations:

- Use raw project Playwright with isolated Chrome contexts; missing prerequisites are `BLOCKED`,
  not permission to switch to MCP or a personal browser. MCP diagnostics require an explicit request.
- Prove checkout freshness before accepting evidence. Use explicit waits and approved test data.
- Capture the default state and materially different affected edge/responsive states. Usually
  2–5 screenshots, at most 10 by default across the run; this is a ceiling, not a quota.
- Open and critically inspect every screenshot against the requirements: layout, colors, typography,
  spacing, clipping, content, and required values. Supplement images with geometry or style/state
  measurements when useful, without arbitrary CSS assertions or one-assertion-per-surface limits.
- Return per-requirement/state `PASS` / `FAIL` / `BLOCKED`, expected versus observed defects, labeled
  screenshot paths, and omitted states. Continue independent checks after individual failures.

The verifier may create a temporary runner and evidence, but must not edit application source,
create persistent tests, manage servers, or automatically commit/upload artifacts or publish CI.

## 4. Report

Evaluate the verifier's concise findings; do not routinely load every screenshot into main context.
Return visual acceptance results and a representative labeled gallery of openable screenshot links
for the user, including relevant edge states and limitations. Keep artifacts available after server
cleanup. Hand defects and blockers back to the caller for repair. Any later repair requires fresh
verification of affected states and replacement of stale screenshots before reporting final success.
