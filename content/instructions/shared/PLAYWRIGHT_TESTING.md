# Playwright Testing — Reliability Contract

Canonical policy for repeatable browser verification. Interactive browser exploration is a separate capability and does
not replace this reliability path.

## Raw project Playwright

Use the project's installed Playwright through a short checked-in or task-local Node runner. Raw Playwright is
deterministic, assertable, and usable in headless CI. Use `mpx-chrome-devtools-tester` only for interactive exploratory
checks, performance traces, or audits that the repeatable runner does not cover.

Discover the project's runner, dev-server command and port, authentication route, and changed surfaces from repository
instructions, `package.json`, and referenced configuration. Follow the shared dev-server startup policy; use the actual
server URL for browser checks. Credentials may be read from approved private local configuration but never hardcoded,
echoed, copied into evidence, or committed.

## Browser isolation

Keep manual development-server auto-open behavior separate from automation. Start agent and E2E servers through the
project's automation entry point with browser auto-open suppressed (`BROWSER=none` for Vite). Apply that environment
only to the server child process, not the user's shell. Never use the OS-default browser as an automation fallback.

Use Google Chrome explicitly for Chromium automation (`channel: 'chrome'`) with temporary Playwright contexts. If Chrome
is unavailable, report the missing prerequisite rather than selecting Brave or another personal browser. Tests requiring
sideloaded extensions may explicitly use Playwright's bundled Chromium with a test-owned profile, because branded Chrome
blocks those extension flags; this is not a default-browser fallback. Interactive Chrome MCP must use an explicitly
configured Chrome executable and a dedicated agent-owned persistent profile. Never
reuse, copy, clean up, or change permissions on personal profiles; never kill personal browser processes. A persistent
agent profile needs exclusive ownership: report contention rather than deleting locks or terminating another owner.

## Reliability principles

1. **Prove checkout freshness first.** Assert a DOM or computed-style fact introduced by the change. On mismatch,
   investigate stale content or a wrong-checkout server. Restart only a server owned by this task; otherwise use a
   reliably configured alternative port or ask before stopping the existing server. Repeat the freshness gate.
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
const browser = await chromium.launch({ channel: 'chrome' });
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

Report `PASS`, `FAIL`, or `BLOCKED` per surface, measured versus expected value, and screenshot path. Publish browser results through the selected repository provider's documented native CI operation; unsupported publication receives a manual handoff.
