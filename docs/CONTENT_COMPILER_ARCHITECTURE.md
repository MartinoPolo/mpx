# Content compiler architecture

## Purpose

`@mpx/content-compiler` is the only component that parses canonical skills and agents and renders their final runtime files. Runtime adapters publish and launch those files without rewriting their bytes.

## Inputs

- canonical skills under `content/skills`;
- canonical agents under `content/agents`;
- shared instructions and provider guides under `content/instructions`;
- runtime mappings in `content/runtime-profiles.json`;
- validated launch bindings, skill packs, exposure policy, and managed project skills.

Canonical content uses semantic model classes and capabilities rather than vendor model IDs or harness-specific tool names. Unknown fields, classes, capabilities, placeholders, references, or required runtime features fail closed.

## Outputs

Each launch compiles a runtime-specific tree containing native `SKILL.md` files, agents, required shared references, runtime context, and `active-content.json`. The manifest records the launch and policy bindings, inclusion decisions, effective descriptions, model mappings, final paths, and hashes without credentials or session content.

Published trees are immutable, content-addressed, and inspectable. Publication validates source containment, deterministic output, reference closure, and final hashes. Inspection reads the persisted manifest and files; it does not recompile them.

## Exposure

| Exposure        | Model discovery      | Human discovery | Explicit load |
| --------------- | -------------------- | --------------- | ------------- |
| `full`          | full description     | yes             | yes           |
| `name-only`     | neutral name trigger | yes             | yes           |
| `explicit-only` | no                   | yes             | yes           |
| `off`           | no                   | no              | no            |

For `name-only`, the compiler emits a neutral description that permits invocation only when the skill name is explicitly mentioned. Runtime-specific controls represent `explicit-only`; unsupported required behavior fails compilation.

## Runtime projections

Claude receives an immutable plugin projection. Pi receives compiled content plus launch context; the checked-in package under `runtimes/pi/extensions` registers canonical commands as `/mpx:<name>` and lazily reads verified compiler-owned bodies. Native project skills remain `/skill:<name>` and are never assigned invented MPX metadata.

Shared references are compiler inputs and projection files. Relative links must resolve exactly in the published tree. Provider workflows select the configured role and load a shipped native-command guide; the compiler does not create provider facade commands.

## Translation profile

`content/runtime-profiles.json` owns semantic model mappings, runtime aliases, capability mappings, supported frontmatter, exposure fields, and the bounded placeholder registry. Secrets and credential paths are not valid substitutions.

## CLI

```text
mpx content inspect
mpx content inspect skill <identity>
mpx content inspect agent <identity-or-projected-name>
mpx content check
```

The generated basic and complete CLI references come from the command registry and are validated as generated artifacts.

## Ownership boundary

Runtime adapters own native projection assembly, settings/hooks wiring, invocation, and runtime capability probes. They do not parse canonical metadata, choose agent mappings, alter compiled skill or agent bytes, or implement provider workflow semantics.
