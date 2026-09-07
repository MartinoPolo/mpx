# Exploration

Canonical policy for finding files, symbols, conventions, and subsystem boundaries.

## Delegate broad search

Keep broad search output out of the orchestration context. Delegate to `mpx-explorer` and retain its conclusion. Reading
two or three already-known files is not exploration and may be done directly.

State the breadth and a stopping condition:

| Breadth         | Scope                                                                       |
| --------------- | --------------------------------------------------------------------------- |
| `quick`         | one known concept in its obvious location                                   |
| `medium`        | obvious locations plus one alternate naming convention                      |
| `very thorough` | exhaust relevant conventions, sibling directories, configuration, and tests |

Breadth controls search scope, not reasoning effort. `mpx-explorer` declares the `exploration` model class and medium
effort in runtime projections. It resolves to Sonnet in Claude Code and Luna in Pi, so callers do not pass a concrete
model.

## Prompt context explicitly

An explorer may not inherit repository instructions, parent git status, or machine-root values. Restate every rule the
search depends on, including scope, exclusions, relevant current changes, and desired evidence. Treat exploration as
one-shot unless the runtime explicitly returns a resumable identity.

Look before asking when repository evidence can answer the question. Ask the user only for product intent, priorities,
taste, outside facts, or a trade-off that requires ownership.

## External documentation

For questions or root-cause analysis about an external tool or library, resolve `MPX_CLONED` at runtime and check that
configured repository collection first. When a matching clone represents the relevant project and version or source, use
its code as the primary implementation evidence.

For current public API and version facts, or when no matching clone exists, use the identity-owned approved
documentation route, normally `mpx-context7-docs-fetcher`. If neither source is available, return a structured
unsupported/manual handoff rather than inventing an API from memory or local dependencies.

## Paths outside the working directory

Resolve machine roots from the environment at execution time:

| Variable             | Purpose                         |
| -------------------- | ------------------------------- |
| `MPX_PROJECTS`       | personal projects               |
| `MPX_WORK`           | work repositories               |
| `MPX_CLONED`         | cloned open-source repositories |
| `MPX_APPS`           | local applications              |
| `MPX_ONEDRIVE`       | OneDrive root                   |
| `MPX_AI_GENERATED`   | generated deliverables          |
| `MPX_OBSIDIAN_VAULT` | Obsidian vault                  |

Values are private, per-machine, and never committed. An unset root is unavailable: name the missing variable and stop
that branch. Do not guess paths. Canonical markdown does not interpolate these values; executable code reads them, or
the parent includes the resolved value in a bounded sub-agent prompt.

Generated deliverables go beneath `MPX_AI_GENERATED` in an all-caps underscore-prefixed category, one run folder per job
containing inputs, prompt, and finished artifacts.

## Related

- [SUBAGENT_PROTOCOL.md](SUBAGENT_PROTOCOL.md)
- [AUTHORING.md](AUTHORING.md)
