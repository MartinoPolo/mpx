# Bounded LEGACY compatibility candidate evidence

Date: 2026-09-13. Scope was checkout-local preparation only; no installation, deployment, real-account config write, dependency change, or edit to either legacy checkout occurred. Local checkpoint commits do not deploy the candidate.

## Candidate

`patches/legacy-footer-native-account.patch` is a unified patch against `../mpx-pi/extensions/footer.ts`. It only removes `homedir`, imports native `getAgentDir`, and returns `getAgentDir()` from `agentDirectory()`. Original footer SHA-256: `0393f1c40f81f1031118b8619ee922bc413c6c8edc92ffc00a60c50e21399174`; patched candidate before probe-only import relocation: `bccd15f33bec33ba61cabcfb53d98cd54c9c0b8d0a3ba99a5cae9542ed844c84`; patch: `df4b08cebd085aec805dea5feae20efd844a04945922ff0a14bbd5c715c6d5bc`.

The launch path does not apply or select this candidate. Its original unsafe-footer guard still refuses a hardcoded `~/.pi/agent` outside the isolated account pending later installation authorization.

## Probe result

Command: `node --import tsx migration/legacy-compat-probe.mjs` (bounded child: 45 seconds). Pi `0.85.1`; actual in-memory model `legacy-probe-fixture/non-codex`; thinking `low`.

Passes (failures: zero):

- Native `DefaultResourceLoader` loaded exactly the copied patched footer, current retained `subagents/index.ts`, and configured local `pi-tool-display` `0.5.0` entry, with discovery, skills, prompts, themes, and context files disabled.
- Footer-specific `fs.readFileSync` path instrumentation observed the selected disposable account settings and did not observe decoy `HOME/.pi/agent` settings. Values were not logged.
- `Agent`, `get_subagent_result`, and `steer_subagent` registered exactly once; retained subagent lifecycle emitted ready.
- No guard/progress/dev-server/worktree extension entrypoint or AgentResurrect was loaded. Fetch and socket hooks rejected their self-tests; no external connection was allowed.
- Inspected source-entry hashes, including retained settings, were unchanged. Subagents: `0fc0a1bf21fe66bdd59840461a2c6bf7ec1ede57cbecf7c8e95b6854ce92a785`; display entry: `72e41c7a9fb0079f03108c190307645ef09f24e8be6b39b324deade6444723b8`.

The copied footer’s one pure relative helper import was relocated, in the disposable fixture only, to original read-only `dev-server/footer-format.ts` (SHA-256 `e405a325ae20842b8381635804459cc52d63c3366c92eeafc605760d81d58e3d`). Absolute legacy script imports were preserved/read-only.

Parent reran the probe after strengthening socket/createConnection rejection, failure cleanup, source-settings comparison and native package-version observation. Socket/fetch self-tests are the only attempts; unexpected additional attempts fail the probe. An initial CommonJS package-resolution failure was corrected to native ESM resolution and rerun successfully.

The entire parent probe now also uses `migration/source-integrity.mjs` for before/after Git-visible
source/index snapshots of `mpx-pi`, `mpx-claude-code`, and configured tool-display, including failure paths.
It preserves both execution and integrity errors. These are explicit read-only external-source dependencies;
ignored caches/account stores are not scanned, and this is not an OS sandbox. Final probe and full
225-test gate passed after this review correction.

Limitations: loader/account-root evidence only; no physical TUI, authenticated provider, live subagent execution, AgentResurrect registration, or full legacy acceptance.
