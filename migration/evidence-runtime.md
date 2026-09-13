# Native runtime composition evidence

`test/native-runtime.test.ts` runs the checkout-local `extensions/pi-runtime.ts` through Pi 0.85.1's public `DefaultResourceLoader` and `createAgentSession` APIs. The child fixture uses an `InMemoryCredentialStore` and stubs only the model stream boundary; it registers only an offline fixture provider, reads no real credential/history file, and actively rejects fetch/socket connection attempts in the fixture process. Parent repaired fixture-only model/auth setup and context cloning (native tool definitions contain functions), then reran both cases successfully on 2026-09-13.

Each personal/work case creates isolated temporary HOME, APPDATA, account, and Git project directories. Parsed assistant tool calls are executed by the native agent loop. Assertions show that:

- mutating `git clean -fd` is blocked before the shell can remove an untracked marker;
- a native `write` targeting Windows `NUL` is blocked;
- safe native `write` and `edit` calls succeed through the composed overrides;
- style, machine-root, shared, and Pi-specific instructions reach every model context;
- checkout-local upstream `Agent`, `get_subagent_result`, and `steer_subagent` tools are active exactly once;
- loader and extension execution report no duplicate-load errors.

Focused command: `node --import tsx --test test/native-runtime.test.ts`
