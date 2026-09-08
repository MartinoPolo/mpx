# Error guidance

Human-readable MPX CLI errors include a diagnostic code, the reason, and a
`POSSIBLE SOLUTIONS/WORKAROUNDS` section. Guidance combines the operation's own
remediation with suggestions for the error code or error family. Unknown errors
provide command-discovery and reporting instructions rather than an invented repair.

Each command is followed by an explanation. In an interactive color-capable terminal,
the command portion is bold cyan so it remains distinct from its explanation. Styling
is disabled for redirected output, `NO_COLOR`, and terminals identified as `dumb`.
Suggestions are alternatives, not a script to execute from top to bottom. Replace
angle-bracket placeholders before running a command. Flag-only entries explain options
to append to the original command so its runtime, identity, executor, and approval
choices are retained.

Recovery guidance does not grant permission, perform repairs, or relax validation.
Read the explanation before running a command: setup changes the installation,
confirmed initialization writes project configuration, and confirmed session resume
can launch a runtime. Preserve user files, sessions, receipts, leases, and locks
when diagnosing ownership or integrity failures.

## Working without project configuration

When a work identity launches from the work domain without project configuration,
MPX automatically selects developer mode only if neither `--mode` nor `--preset`
was supplied. It emits `PROJECT_CONFIG_MISSING_DEVELOPER_FALLBACK` before an
interactive child starts and includes the warning in returned JSON. Explicit
`--mode project` and presets retain strict project intent and may report
`PROJECT_REQUIRED`. Malformed project configuration never triggers the fallback.

The fallback does not turn a repository into an MPX-managed project or enable
project-dependent workspace and service operations. Developer mode normally grants
broader identity-domain access than project mode; it is not a project-isolation
substitute.

Identity/domain mismatches remain rejected with or without project configuration,
unless an explicit trusted grant applies. Personal special-purpose modes may access
only their matching assistant or computer-control domains when their configured
resources authorize that domain and the mode was explicitly selected or selected by
a personal preset.

Other modes serve different purposes. The user configuration is authoritative for
available modes and their resource declarations:

- `project`: work associated with a canonical project ID.
- `developer`: identity-domain development, with cloned repositories normally read-only.
- `personal-assistant`: assistant input and output resources.
- `computer-control`: computer-control configuration and staged executable settings.
- `unrestricted`: broad host access, requiring a reason and separate trusted approval;
  not a recommended workaround for a missing project ID.

To adopt project configuration instead, `mpx init` previews initialization;
`mpx init --confirm` explicitly authorizes writing it. Do not initialize a work
repository unless you intend to add that configuration.

## Automation and coverage

`--json` retains the existing versioned error envelope and exit status. Human
presentation guidance is not added to JSON or runtime-tool protocol schemas.
Existing structured remediation remains available as before.

The shared formatter applies to errors normalized by the MPX CLI. Native runtime
startup errors, shell/bootstrap failures before the CLI loads, and separate tool
protocol errors may use their own presentation. A diagnostic suggestion such as
`mpx doctor` or `mpx content check` gathers evidence; it is not a promise of repair.
When seeking help, retain the diagnostic code and redact credentials and private
configuration from any shared output.
