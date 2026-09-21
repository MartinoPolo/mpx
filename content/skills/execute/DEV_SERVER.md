# Execute: Development-server discovery and lifecycle

Main owns server preparation for this execution; browser agents receive a verified URL, not a
request to ask the user for one. Start only when acceptance checks need a live application. Respect
explicit project restrictions and the execution environment's process permissions.

## Discover and start

1. Inspect repository instructions, `package.json` scripts and `packageManager`, lockfiles, workspace
   configuration, framework configuration, and referenced documentation. Select the relevant app
   and its working directory, not an arbitrary monorepo root. Prefer the documented command;
   otherwise use an existing `dev`, `start`, or `storybook` script appropriate to the check (for
   example, `pnpm dev` when pnpm and that script are confirmed). Inspect what a command does before
   running it; avoid deployment, destructive setup, and unrelated services.
2. Reuse a supplied or discovered running URL only after confirming it serves the intended project
   and checkout. Reachability alone does not establish identity. If none is suitable, launch the
   discovered command using the environment's supported background-process mechanism, capture logs
   outside tracked files, and retain the process identity for cleanup.
3. Use project-configured host and port or framework defaults; optional MPX port metadata is not a
   prerequisite. If the port is occupied by another or unidentified process, leave it alone. Use
   an alternate port only when supported configuration can keep app, dependent services, callbacks,
   and test URLs consistent; otherwise report the concrete conflict.
4. Observe startup output, resolve the actual URL, and confirm readiness with a bounded wait and a
   request to the intended application route. A running process or guessed localhost URL is not
   readiness evidence. Pass the verified URL, working directory, and relevant configuration to
   `mpx-visual-verifier` and server-dependent checks. The verifier never manages server processes or
   modifies source. If the test runner manages its own server, use that configuration instead of
   starting a competing process.

## Recovery and cleanup

On failure, inspect bounded startup logs and attempt evidence-based local repairs or another
confirmed script. Do not blindly cycle package managers, install arbitrary tooling, invent secrets,
or weaken authentication. Stop after a bounded recovery attempt if missing credentials, external
services, process permissions, or incompatible configuration still block startup. Report commands
attempted and the concrete blocker; ask only for the missing input that cannot be discovered.
Required browser verification remains blocked, not passed or silently skipped.

At completion or failure, stop only processes started for this execution and release their resources.
Do not stop or restart user-owned servers. Report verification evidence and any cleanup failure in
the final result; never commit startup logs or transient server configuration.
