# Runtime tools semantic provenance

`@mpx/runtime-tools` is a clean-room, provider-neutral implementation. It does not import, copy, bundle, or redistribute
either reviewed package, so neither package is a runtime dependency and no version pin was added.

Reviewed from an installed Pi package set on 2026-03-17:

#### Package: `pi-mcp-adapter`

- **Version:** 2.27.0
- **License metadata:** MIT
- **Installed lock integrity:**
  `sha512-IM9dfGhou5Q5AJqwkm1kW1+WXyMsvL53GEO4JVYukzvTxNPHn2b+Zi49+JAnOhlaOpEq5vEodUSJXmpghik+lw==`
- **Semantic surface reviewed:** aggregate proxy shape, lazy server launch, config/discovery, registration, OAuth,
  sampling and elicitation capabilities

#### Package: `pi-web-access`

- **Version:** 0.24.2
- **License metadata:** MIT
- **Installed lock integrity:**
  `sha512-wpw1XJLITrLY5epZCjiGxdF75HlKgZTrK1UM3TG/AVRzRrFqvNoc4bLYaCFFjYUG8QNEo6dIpYbCJyAUkLz/QA==`
- **Semantic surface reviewed:** aggregate tool names, provider adapter model, Firecrawl fallback semantics, manual
  redirects and cache behavior

The package intentionally exposes only immutable launch-bound aggregate contracts. Features observed in the semantic
inputs that mutate or discover ambient configuration, onboard accounts, manage OAuth/keyrings, register direct tools or
servers, or service MCP sampling/elicitation are excluded by design.
