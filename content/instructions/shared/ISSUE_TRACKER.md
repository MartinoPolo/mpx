# MPX Issue, Review, and CI Contracts

Canonical skills use provider-neutral MPX contracts. They do not detect hosting providers or invoke
provider CLIs. The immutable launch identity selects an approved adapter and account.

## Identity

Pass `--identity <launch-identity>` and `--json` on every operation. Reuse the identity selected at
launch; never infer an account or repository from remotes. If identity is unavailable or ambiguous,
stop and ask the user.

## Capabilities

| Intent | Contract |
| --- | --- |
| Create work | `mpx issue create --identity <launch-identity> --json` with title, body, semantic labels |
| Read work | `mpx issue view --identity <launch-identity> --json --id <issue-id>` |
| Update/comment | `mpx issue update --identity <launch-identity> --json --id <issue-id>` |
| Open review | `mpx review create --identity <launch-identity> --json` with source and target branches |
| Read review | `mpx review view --identity <launch-identity> --json --id <review-id>` |
| Update review | `mpx review update --identity <launch-identity> --json --id <review-id>` |
| Inspect CI | `mpx ci status --identity <launch-identity> --json` with explicit review or pipeline ID |

Use structured response IDs for every later operation. There is no implicit issue, review, or CI
discovery. Preserve schema/version fields and fail closed on an unknown response version.

## Unsupported operations

Adapters may not support every field or operation. Preserve the structured error and return a
manual handoff containing:

- launch identity (opaque ID only, no credentials);
- requested capability and target ID;
- unsupported field/operation code;
- safe remaining steps and the user decision needed.

Do not fall back to provider CLIs, copy tokens between tools, silently omit fields, or reinterpret an
unsupported operation.

## Semantic labels

Submit labels as semantic requests such as `bug`, `task`, `enhancement`, `Design needed`, `HITL`, or
`AFK`. The adapter maps or rejects them. Do not create provider-native labels, reinterpret them, or
silently continue without a rejected label. Ask whether to proceed without it.
