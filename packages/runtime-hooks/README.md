# `@mpx/runtime-hooks`

Portable policy functions shared by runtime adapters. The package classifies and plans; it does not
parse native runtime events, execute commands, call provider CLIs, or persist runtime state.

## Boundaries

- Executable work is represented as an executable plus argv, never shell command text.
- Provider targets and native command execution remain adapter responsibilities.
- Dangerous-command uncertainty fails closed. Wrapper recursion and input size are bounded.
- Secret and pre-commit failures block. Optional formatting, context, compaction, notification, and
  unavailable Fallow infrastructure follow their explicit warn/fail-open contracts.
- `dangerousCommandPolicyModuleSource` is generated from the same classifier as the package API so
  runtime projections do not maintain a second rule table.
- Runtime-specific event names, payloads, process spawning, and exit behavior remain outside this
  package.

## Policies

| Area                   | API                                         | Failure behavior                                 |
| ---------------------- | ------------------------------------------- | ------------------------------------------------ |
| package manager        | `evaluatePackagePolicy`                     | wrong manager blocks                             |
| dangerous commands     | `classifyDangerousCommand`                  | uncertainty blocks                               |
| pre-commit and secrets | `evaluatePreCommit`                         | detected risk or check failure blocks            |
| Fallow                 | `evaluateFallowGate`                        | regression blocks; unavailable tooling warns     |
| post-write quality     | `planFileQuality`                           | returns bounded argv plans                       |
| post-command context   | `extractPostCommandContext`                 | invalid assumptions produce no context           |
| session context        | `buildMachineContext`, `planSessionContext` | missing roots produce no context                 |
| compaction             | `planCompactionInjection`                   | unavailable canonical input uses runtime default |
| notification           | `planNotification`                          | delivery failure does not fail the turn          |

Adapters gather native evidence, execute returned plans, and translate native lifecycle events. They
must not import former source checkouts or private runtime state.
