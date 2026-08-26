# Phase I acceptance

Phase I is accepted only from simulation and read-only live inspection. **Do not run install apply against the developer machine.** Production-backed simulations use temporary `MPX_APPS`, `APPDATA`, `LOCALAPPDATA`, and `USERPROFILE` roots, real file transaction stores, and fake Windows-native boundaries.

## Required gates

| Area | Required evidence |
|---|---|
| Immutable release | Every projected payload file is in the release manifest; release and projection digests match; no credentials, auth, sessions, cache, trust, or native runtime data is copied. |
| Runtime matrix | Exactly `claude-personal`, `claude-work`, `pi-personal`, and `pi-work`; executable and projection verification healthy; native roots non-overlapping; all four account probes enrolled and domain-bound. |
| Existing machine | Auth, session, and native-root fixtures remain byte-identical. Foreign Terminal profiles, profile bytes outside the managed block, environment values, shortcuts, and tasks remain present. |
| Apply | Plan is read-only. Exact confirmation applies once; a second apply converges. Scheduled capture is last and directly invokes verified Node plus the receipt-bound immutable `bin/mpx.mjs`. |
| Task evidence | Exact task path, name, principal, action, trigger, and settings inspect successfully. A manually started task has structured last-run time and zero result. |
| Drift/refusal | Same-name foreign resources, changed observations, owned drift, root overlap, incomplete projection, and account mismatch are unhealthy or refused before mutation. |
| Recovery | Failure after each operation restores snapshots in reverse order. Interrupted journals recover. Cross-process lock ownership is respected and abandoned locks are cleaned only for nonexistent PIDs. |
| Uninstall | Only receipt-owned exact resources are removed, including the active-release selector. Foreign/drifted targets are preserved and refusal is reported. |
| CLI | `mpx install verify` on an uninstalled machine returns versioned structured unhealthy data containing `receipt-missing`; it is not reported as capability unavailable. |
| External systems | Git, Obsidian, and Raycast plans contain bounded references, confirmation digests, and verifier references. No external mutation occurs automatically. |

Run the workspace build, checks, tests, generated-source validation, convergence verification, and native inventory validation. Any unavailable live-only gate remains explicitly pending; simulation is never described as live proof.
