# Sentry Diagnosis Contract

Sentry diagnosis uses the `sentry` CLI or loaded Sentry MCP tools; it is not a standalone exposed skill.

## Route and identity

Prefer the `sentry` CLI when it is authenticated for the target instance: it reaches self-hosted
servers and returns JSON. Otherwise use the Sentry MCP tools loaded in the session. The CLI binds one
config directory to one host, so with several accounts select one with `SENTRY_CONFIG_DIR` and confirm
it with `sentry auth whoami`. Never request, display, copy, exchange, or persist a Sentry token. If
neither route is authenticated, stop with the structured handoff below.

Select organization and project explicitly from the native tool's authorized inventory. When more than
one authorized match exists, ask the user; do not infer from repository names, remotes, URLs, or
previous sessions. Include selected opaque organization/project IDs in evidence, not credentials.

## Read-only diagnosis default

Default operations are read-only: list authorized projects, read issue/event details, inspect stack
traces and breadcrumbs, compare releases, and summarize likely code ownership. Mutations such as
resolve, ignore, assign, delete, change alerts, or update project settings require explicit user
approval and adapter support for that exact operation.

Correlate findings with the supplied release, environment, time range, issue/event ID, and code
revision. Distinguish observed Sentry evidence from hypotheses and local-code inference.

## Privacy and evidence

Treat event payloads as sensitive. Before storing or reporting evidence, redact:

- authorization headers, cookies, tokens, keys, and connection strings;
- email addresses, IP addresses, user IDs, request bodies, and other PII unless essential and
  explicitly approved;
- local absolute paths and private environment values.

Prefer counts, fingerprints, bounded stack frames, release IDs, and redacted excerpts. Do not paste
raw event JSON into issues, reviews, logs, prompts, or committed files.

## Unsupported/manual handoff

When the CLI and MCP routes, organization/project selection, capability, or authorization is unavailable, return:

```text
status: unsupported | manual-required
route: <cli, mcp, or unavailable>
organization/project: <opaque selected IDs or ambiguous>
requested operation: <read or mutation>
reason: <structured adapter/error code>
redactions applied: <categories>
manual next step: <specific user action>
```

Never bypass the CLI or MCP route with a direct API call. Never expose this contract as an
independently invocable skill; workflows link to it only when Sentry diagnosis is required.
