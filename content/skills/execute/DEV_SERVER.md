# Development server

Main owns server startup and cleanup. Prepare a server only when verification needs one.
Resolve `MPX_AI_DUMP` and `MPX_TEMP` from the environment. Keep logs and verification evidence in
`<MPX_AI_DUMP>/_VERIFICATION/<run>` for a unique run; disposable runners and scratch belong under
`MPX_TEMP`. If a required root is unset, relative, or unwritable, report a blocker; never guess a
fallback.

## Prepare

- Read repository instructions, `package.json`, and referenced configuration. Select the relevant
  app, working directory, package manager, and documented dev or Storybook command.
- Respect project restrictions and resource isolation. Serialize shared resources when no isolation
  contract exists. Do not compete with a test runner's managed server.
- Reuse a server only after confirming its owner, checkout, and configuration. Otherwise start one
  with supported background controls; retain its process handle and keep logs in the evidence
  directory.
- Use configured ports or framework defaults. Optional MPX port metadata is not required.
  Leave occupied ports alone; use a supported isolated alternative or follow section 4's bounded wait.
- Confirm the intended route is ready and serves the current implementation, not just any response.
  Bound startup to the project limit, default two minutes.
- Give browser agents the verified URL, relevant app/auth configuration, isolation rules, resolved
  evidence and scratch paths, and execution/cleanup limits. Use only approved test access.
- Serialize builds and servers that share generated output. Stop only owned servers and verify
  readiness again after restarting.

## Recover and clean up

- Inspect bounded logs and recover under section 4's repair limits, including documented local
  dependencies. Ask only for prerequisites that cannot be safely recovered with existing authorization.
  Do not invent credentials, weaken authentication, or install arbitrary tools.
- On success or failure, close owned resources and stop only processes started for this task.
  Never stop user-owned processes or remove another owner's locks.
- Release leases only after resources are idle. Bound cleanup to the project limit, default one
  minute. Report hangs, cleanup failures, and retained process handles as blockers.
- Keep verification artifacts available for the final report. Do not commit logs or temporary files.
