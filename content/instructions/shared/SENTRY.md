# Sentry Diagnosis Contract

Sentry is an identity-owned approved tool route, not a standalone exposed skill.

## Route and identity

Use only the Sentry capability bound to the immutable MPX launch identity. The adapter selects the approved account and
authentication context. Never request, display, copy, exchange, or persist a Sentry token. If the approved route is
unavailable, stop with the structured handoff below.

Select organization and project explicitly from the identity-authorized inventory. When more than one authorized match
exists, ask the user; do not infer from repository names, remotes, URLs, or previous sessions. Include selected opaque
organization/project IDs in evidence, not credentials.

## Read-only diagnosis default

Default operations are read-only: list authorized projects, read issue/event details, inspect stack traces and
breadcrumbs, compare releases, and summarize likely code ownership. Mutations such as resolve, ignore, assign, delete,
change alerts, or update project settings require explicit user approval and adapter support for that exact operation.

Correlate findings with the supplied release, environment, time range, issue/event ID, and code revision. Distinguish
observed Sentry evidence from hypotheses and local-code inference.

## Privacy and evidence

Treat event payloads as sensitive. Before storing or reporting evidence, redact:

- authorization headers, cookies, tokens, keys, and connection strings;
- email addresses, IP addresses, user IDs, request bodies, and other PII unless essential and explicitly approved;
- local absolute paths and private environment values.

Prefer counts, fingerprints, bounded stack frames, release IDs, and redacted excerpts. Do not paste raw event JSON into
issues, reviews, logs, prompts, or committed files.

## Unsupported/manual handoff

When identity, organization/project selection, capability, or authorization is unavailable, return:

```text
status: unsupported | manual-required
identity: <opaque launch identity or unavailable>
organization/project: <opaque selected IDs or ambiguous>
requested operation: <read or mutation>
reason: <structured adapter/error code>
redactions applied: <categories>
manual next step: <specific user action>
```

Never bypass the route with a direct API call or provider CLI. Never expose this contract as an independently invocable
skill; workflows link to it only when Sentry diagnosis is required.
