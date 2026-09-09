# Error guidance

Human-readable MPX CLI errors include a diagnostic code, reason, and `POSSIBLE SOLUTIONS/WORKAROUNDS`. Suggestions do not grant permission, perform repairs, relax validation, or form a script to run top-to-bottom. Replace placeholders and understand setup, initialization, migration, or resume mutations first.

## Selection failures

Identity is explicit and immutable. A project, location, directory, provider, or Git remote cannot select identity or credentials. MPX rejects:

- a requested skill pack outside `identities.<id>.allowedSkillPacks` rather than filtering it;
- unresolved or equally specific ambiguous canonical locations rather than exposing every pack;
- identity/domain mismatches rather than treating a resource name as authority;
- malformed project configuration rather than skipping it for an ancestor;
- stale launch, artifact, account-root, executor, or session bindings rather than guessing.

Effective packs come from committed project `skills.packs`, then user-local project selection, then the most-specific containing user-local location. Configure an appropriate location or project selection and relaunch. Ordinary directory changes do not update a running inventory.

Supported modes are `project`, `developer`, `computer-control`, and `unrestricted`. There is no `personal-assistant` mode or special domain-name inference. Assistant inputs/outputs and cloned sources are ordinary configured resource roots admitted by an explicit mode and canonical root; a name such as `oss` grants nothing. `unrestricted` still requires a reason and separate fresh approval.

Named `clean`, `developer`, and `personal-assistant` skill policies, content-scope overrides, per-project/per-scope exposure overrides, `off`, and extra grants were removed. There is no replacement global clean switch or per-project individual disable. A host agent's filesystem reads were never mediated by the removed grant plumbing; Windows host execution remains explicitly approved but not isolated. Docker is unavailable and has no host fallback.

## Configuration diagnosis

`CONFIG_INVALID` reports a JSON pointer and a safe reason without echoing configuration values or private root paths. Inspect that field in the project `mpxconfig.json` or user-local `%APPDATA%/mpx/config.json`, compare it with the current schemas, and check required or unknown fields and referenced `MPX_*` environment roots. Malformed and duplicate JSON are reported directly; `mpx doctor` is not a repair step for an invalid file.

## Automation and coverage

`--json` retains versioned error envelopes and exit status. Native runtime startup, shell/bootstrap, and tool protocols may use their own presentation. Diagnostics such as `mpx doctor` or `mpx content check` gather evidence, not promise repair. Preserve diagnostic codes and redact credentials and private configuration when seeking help.
