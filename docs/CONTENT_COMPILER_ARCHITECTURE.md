# Content compiler architecture

## Purpose

`@mpx/content-compiler` is the sole parser and final-byte renderer for canonical skills and agents. Runtime adapters publish verified output unchanged.

## Inputs and contracts

Inputs are canonical `content/skills`, `content/agents`, shared instructions/provider guides, `content/runtime-profiles.json`, immutable launch bindings, effective selected packs with provenance, and explicitly opted-in managed project skills. Current versioned boundaries are runtime/resolved manifests and runtime artifacts schema 5, runtime context schema 2, active-content manifest schema 2 with compiler version 2.0.0, runtime profile schema 1, core skill artifact schema 4, and launch descriptor schema 3. Unknown or stale versions fail closed; normal operation has no legacy readers.

Canonical packs are `development` and `personal`. Identity allowance and project/location selection occur before compilation. The compiler does not infer identity, credentials, provider roles, repositories, or pack authority from paths.

## Exposure

| Exposure        | Model discovery              | Human discovery | Explicit lazy load |
| --------------- | ---------------------------- | --------------- | ------------------ |
| `full`          | description/trigger metadata | yes             | yes                |
| `name-only`     | neutral name trigger         | yes             | yes                |
| `explicit-only` | no                           | yes             | yes                |

A valid managed skill with omitted exposure defaults to `full`; explicit values are preserved. `full` never eagerly loads the body. `off`, named policies, and contextual exposure overrides are not supported.

Canonical assignment follows purpose: personal contains `clean-pc`, `podcast`, `project-register`, `raycast-config`, `tutorial-create`, and `video-to-image`; other reviewed canonical workflows are development. `board-setup` and `board-to-issues` are explicit-only; `init-github-repo` and `notebooklm` are name-only; `project-register` is personal and explicit-only. Other explicit metadata remains unchanged. This rule avoids brittle count tables as the catalog evolves.

## Outputs and ownership

Each launch compiles a runtime-specific immutable, content-addressed tree with native skill files, agents, references, runtime context, and `active-content.json`. The manifest records selection provenance, inclusion, effective descriptions, mappings, paths, and hashes without credentials or session content. Publication validates containment, deterministic output, reference closure, and hashes; inspection reads persisted output rather than recompiling.

Canonical skills retain `/mpx:<name>`. Valid managed-project opt-in uses `metadata.mpx.projectExposure` (`full`, `name-only`, or `explicit-only`) and retains `/skill:<name>`. Unmarked project skills remain native. Canonical/project identities and generated roots stay separate, so same-name entries remain distinguishable. Malformed metadata, ambiguous ownership, collisions, unsafe links, escapes, or changed input fail closed.

Claude receives immutable `mpx` and optional `skill` plugins. Pi receives compiled content and launch context; its checked-in extension registers accepted inventory, offers human name completion without body reads, and lazily verifies bodies on intended exact invocation. Runtime adapters implement native controls without claiming unsupported API parity or rewriting compiler bytes.

Provider workflows use independently selected repository/Issue roles and shipped native-command guides. The compiler creates no provider facade and never owns credentials.

## CLI

```text
mpx content inspect
mpx content inspect skill <identity>
mpx content inspect agent <identity-or-projected-name>
mpx content check
```

Generated CLI references come from the command registry and are not hand-edited.
