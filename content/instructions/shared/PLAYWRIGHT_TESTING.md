# Playwright Testing — Reliability Contract

Canonical policy for repeatable browser verification. Interactive browser exploration is a separate capability and does
not replace this reliability path.

## Raw project Playwright

Use the project's installed Playwright through a short checked-in or task-local Node runner. Raw Playwright is
deterministic, assertable, and usable in headless CI. Use `mpx-chrome-devtools-tester` only for interactive exploratory
checks, performance traces, or audits that the repeatable runner does not cover.

Discover the project's runner, dev-server command and port, authentication route, and changed surfaces from repository
instructions and configuration. Credentials may be read from approved private local configuration but never hardcoded,
echoed, copied into evidence, or committed.

## Reliability principles

1. **Prove checkout freshness first.** Assert a DOM or computed-style fact introduced by the change. A mismatch means
   the server is stale or belongs to another checkout; stop it through the approved process route, start this checkout,
   and repeat the gate.
2. **Assert measured outcomes.** Prefer computed style, geometry, accessibility state, or DOM facts. Screenshots are
   evidence, not the only assertion.
3. **Authenticate programmatically.** Use the project's test/auth API and storage state rather than driving the login
   UI, unless login itself is the changed surface.
4. **Wait explicitly.** Navigate with a finite lifecycle event and wait for a known selector or condition. Do not use
   `networkidle` on websocket, SSE, or long-poll applications.
5. **Test each changed surface once.** Continue after individual failures and report the complete matrix.

Pure backend or logic changes do not require visual checks. Map each UI change to at most one surface and avoid
re-verifying untouched pages.

## Runner shape

```js
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://localhost:5173';
const browser = await chromium.launch();
const context = await browser.newContext();

const gate = await context.newPage();
await gate.goto(base, { waitUntil: 'load' });
// Assert one fact unique to the checkout under test.

for (const surface of surfaces) {
  const page = await context.newPage();
  await page.goto(base + surface.path, { waitUntil: 'load' });
  await page.waitForSelector(surface.ready);
  const measured = await page.evaluate(surface.measure);
  surface.assert(measured);
  await page.screenshot({ path: surface.evidence });
}

await browser.close();
```

Report `PASS`, `FAIL`, or `BLOCKED` per surface, measured versus expected value, and screenshot path. Browser results
required by CI are published through the MPX CI contract under the launch identity; unsupported publication receives a
manual handoff.
