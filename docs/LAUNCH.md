# Launch resolution

`@mpx/launch` resolves pure, deeply immutable launch descriptors. It does not start a runtime, mint approvals, persist audit data, or mutate host, Docker, native-account, or MPX state.

## Immutable tuple

A resolver request must name `runtime: "claude" | "pi"`. Runtime is a typed descriptor field and a `launchKey` dimension. Identity always comes from an explicit identity or short alias; neither CWD, a launch default, nor a preset may infer it. Pure short aliases supply only runtime and identity: `cc` → `claude/personal`, `ccw` → `claude/work`, `pi` → `pi/personal`, and `piw` → `pi/work`.

Selection is deterministic per axis: a direct axis flag wins, then a user project launch default keyed by canonical `project.id` and explicit identity, then the longest-root content-scope default keyed by that identity, then built-in safe defaults. Built-ins are the mode inferred from the recognized CWD domain, `clean`, the classified content scope, `docker`, `clone`, and `implementation`. A selected preset retains its name and identity; its identity must match the explicit identity. Direct mode, skill-policy, content-scope, executor, workspace, and network-policy flags override preset values rather than conflicting. Public per-axis provenance is limited to `explicit`, `user-project`, `user-scope`, and `built-in` and contains no roots.

The supplied skill artifact must declare the same runtime and provide lowercase SHA-256 values for `artifactKey`, `catalogHash`, and `effectivePolicyHash`. The descriptor retains only those verified identifiers. Raw skill artifact inputs are not accepted.

`launchKey` is the SHA-256 canonical hash of the full resolved tuple. Runtime, identity, the selected validated mode declaration and its closed symbolic resource matrix, skill policy, executor facts and availability projection, workspace strategy, effective named network policy, preset, safe provenance, diagnostics, content scope, normalized grants, CWD classification, every route, canonical policy-input digest, trusted approval digest, artifact identifiers, and sanitized elevation audit/banner data are intrinsic dimensions. Objects and nested arrays are deeply frozen. CWD classification is reported as a fact only; it never creates a resource grant.

## Privacy and routes

Raw `policyInputs` are canonical-hashed during resolution and are never retained. Prompts, tokens, auth/private-key paths, raw artifact inputs, native runtime roots, and unnecessary paths therefore cannot be recovered from a descriptor. `serializeLaunchPublic` and `serializeLaunchAudit` clone this already-safe descriptor; privacy does not depend on serialization.

Identity routes are minimal opaque labels. Path-bearing values, executable/private-key names, and secret-, token-, password-, credential-, or key-bearing labels fail with `ROUTE_LABEL_INVALID`.

## Grants and trusted approvals

Requested grants use `ro:<resource>` or `rw:<resource>`; a bare resource remains read-only shorthand. Requested grants are not trusted approvals. Every grant, including read-only and same-domain grants, requires:

- a separate exact approval record for the same access and resource;
- a valid opaque SHA-256 `approvalKey`;
- a nonempty approval reason exactly matching the launch reason.

Missing, mismatched, empty-reason, or malformed approvals fail with stable `GRANT_APPROVAL_REQUIRED`. Read/write remains explicit, and `unrestricted` remains an explicitly selected mode with its own separate trusted elevation approval. Any grant or unrestricted mode requires a nonempty human reason. The descriptor retains only a canonical approval digest and a bounded sanitized reason, never the raw approval record.

The inspection CLI does **not** mint approvals. Approval confirmation and audit persistence belong to Phase F. Consequently, inspection requests containing `--grant` fail with `GRANT_APPROVAL_REQUIRED` until invoked by a future trusted confirmation flow.

Elevated descriptors include persistent banner data (`ELEVATED_LAUNCH`) and a sanitized local-audit projection. Persistence remains deferred to Phase F.

## Effective executors

Intended policy and effective enforcement are separate facts.

- `docker` is the safe default and remains selected when unavailable or not yet verified. The descriptor emits an actionable projected/unverified gate diagnostic and never silently falls back to host. It reports `mount-enforced`, container-boundary interception, explicit mounts, mount-dependent confidentiality, host readability, and the host-service/direct-extra-mount limitations. It is never summarized merely as “sandboxed.”
- `host` is elevated compatibility mode. It must be explicitly selected with a nonempty human reason and separate exact trusted approval, produces persistent elevation banner/audit data, reports `advisory` and `isolation: "none"`, and exposes policy-hook/raw-shell/direct-filesystem/unmanaged-child limitations. `host` plus `clone` is rejected.

Executor projection and Docker execution still belong in `@mpx/executors`; this package records immutable selection and gate facts only.

## CLI inspection surface

The Phase B2 CLI surface is deliberately read-only:

```bash
mpx identity list --json
mpx identity show work --json
mpx mode list --json
mpx skill-policy show clean --json
mpx preset show work-project --json
mpx launch explain --identity work --runtime pi --cwd . --json
mpx launch explain --cwd . --json
```

`identity`, `mode`, `skill-policy`, and `preset` support deterministic `list` and `show` operations. Identity output omits native runtime roots. `launch explain --identity ...` resolves one privacy-safe selection; `--runtime claude|pi` is optional. Without identity it reports sorted identity-specific candidates and provenance for the requested CWD without selecting an identity. It does not start a process or mutate native, runtime, Docker, or MPX state.

Skill commands require explicit `--identity`, `--skill-policy`, and `--runtime claude|pi`. `--content-scope` is catalog composition, not filesystem authority. Runtime-bound skill search additionally requires the exact `--artifact-key`; stale keys fail with `STALE_ARTIFACT`.

Runnable `mpx launch claude|pi` performs the same resolution first, then remains non-spawning in B2 and returns `LAUNCH_EXECUTION_DEFERRED` with the Docker/runtime gate remediation. It never falls back to host.

## Deferred runtime integration

Runtime/executor consumers must still:

1. expand `cc`, `ccw`, `pi`, and `piw` only through `resolveLaunchAlias`, without supplying mode or policy;
2. pass canonical project `project.id` into selection so project defaults outrank longest-root scope defaults;
3. expose direct workspace and network-policy axes and allow all direct per-axis values to override presets;
4. render safe provenance and Docker projected/unverified gate diagnostics, never substituting host;
5. collect trusted host approval plus human reason and reject host/clone before calling execution;
6. consume workspace and effective network policy from the descriptor as launch-key dimensions.

The former preliminary call with a fake `pending` artifact remains invalid. CLI consumers use `resolveLaunchSelection` to resolve validated axes without fabricating an artifact, construct the policy-bound manifest, then call `resolveLaunch` with verified hashes. No Docker or host execution is added here.
