# `@mpx/runtime-hooks`

Portable, runtime-neutral policy functions shared by MPX runtime adapters. The package
classifies and plans; it does not parse runtime events, write stdin/stdout, invoke a
shell, call provider CLIs, or persist runtime state.

## Provenance

The behavior was ported from the maintained MP hook sources at the Phase F migration
baseline. Compact reinjection also used two non-Git local source files. Their SHA-256
hashes record the exact reviewed baseline without creating a runtime dependency:

| Logical source                   | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `codex/hooks/compact-context.js` | `7c66b56f1936691b8fb8b2d4fe8267e411a8b818ee5feddf0855a17e9529e85d` |
| `codex/hooks/shared.js`          | `b0b3bf430c43062b228b210c72b522a44da44b05eafbf7609f813d990273ebe6` |

No source content, machine credentials, sessions, or state is bundled.

## Boundary decisions

- Command execution and executable discovery belong to adapters. Format/lint output is
  an executable plus argv, never shell text.
- Pull-request context comes from explicit provider-neutral MPX assumptions. Provider
  CLI lookup and provider-specific URL extraction are deferred to adapters.
- Dangerous-command and staged-secret size failures are fail-closed. Recursive-delete
  flags and targets must be statically constrained; unresolved expansion is blocked.
  Payloads passed through `env`, `command`, `sh`/`bash`, `cmd`, PowerShell, and `eval`
  are recursively classified through at most 8 wrapper levels. Wrapper input is bounded
  to 32,768 characters. Opaque payloads, malformed wrapper syntax, and excess nesting
  produce structured `OPAQUE_COMMAND_WRAPPER`, `MALFORMED_COMMAND_WRAPPER`, and
  `WRAPPER_DEPTH_EXCEEDED` decisions. This is bounded tokenization, not a general shell
  parser. Missing fallow, audit runtime errors, and compact instruction read failures
  remain visible fail-open outcomes.
- Runtime projections can import `dangerousCommandPolicyModuleSource`, persist that
  string as an `.mjs` module, and import its named or default
  `classifyDangerousCommand` export. The standalone source has no imports or workspace
  dependencies and is generated from the same classifier factory used by this package.
- Adapters normalize harness events to semantic contracts. Guard observations are
  resolved in fixed policy order, so differing Claude/Pi event timing cannot alter the
  result. Dangerous-command infrastructure failure is fail-closed; package, pre-commit,
  Fallow, post-command, formatting, context, compaction, and notification infrastructure
  failures are visible or silent fail-open according to their source behavior.
- Runtime-specific event names, exit codes, payload envelopes, process spawning, and
  automatic draft-review creation remain adapter responsibilities.

## Behavior matrix

| Behavior               | Shared contract                             | Failure disposition                                                            |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Package manager        | `evaluatePackagePolicy`                     | Wrong manager blocks; capability warnings allow                                |
| Dangerous command      | `classifyDangerousCommand`                  | Classification/input/infrastructure uncertainty blocks                         |
| Pre-commit and secrets | `evaluatePreCommit`                         | Secret or check failure blocks; discovery failure is adapter-visible fail-open |
| Fallow                 | `evaluateFallowGate`                        | Audit fail/old version blocks; unavailable/runtime error warns and allows      |
| Post-write quality     | `planFileQuality`                           | Returns argv plans; adapter runs best-effort                                   |
| Post-command context   | `extractPostCommandContext`                 | Missing/invalid assumptions produce no context                                 |
| Session context        | `buildMachineContext`, `planSessionContext` | Missing roots produce no context                                               |
| Compaction             | `planCompactionInjection`                   | Uses runtime default when canonical injection is unavailable                   |
| Notification           | `planNotification`                          | Top-level Windows turns use background flash/beep; delivery failure is ignored |

## Adapter gaps

Claude and Pi still need thin wiring to gather staged diffs and package metadata, execute
check and quality argv plans, turn provider results into post-command assumptions, map
native lifecycle events to `turn-settled` and `before-next-model-turn`, perform native
compaction calls, and deliver the Windows notification capability. No adapter may import
the old source checkouts or `~/.codex`.
