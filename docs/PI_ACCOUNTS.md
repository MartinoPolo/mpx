# Pi account enrollment

Pi account roots are configured only in strict user config. Commands never accept a root.
`LOCALAPPDATA` must be an absolute path.

```text
mpx account enroll --identity NAME
mpx account enroll --identity NAME --confirm-plan DIGEST
mpx account re-enroll --identity NAME
mpx account re-enroll --identity NAME --confirm-plan DIGEST
mpx account list
mpx account status --identity NAME
mpx account verify --identity NAME
```

Planning does not write or run the live-auth probe; it proves only the configured root and
current registry state and returns the digest that binds those facts. Confirmation re-plans,
then checks the trusted Pi executable and live OAuth availability before committing. Re-enrollment preserves
the opaque reference used by native session bindings.

The private atomic registry stores only schema version, opaque reference, identity, runtime
`pi`, canonical root digest, `root-attested` mode, and timestamps. Public output omits the
root path and opaque reference. MPX never reads `auth.json`, requests credentials or tokens,
decodes JWTs, or retains probe output.

The supported probe is exactly:

```text
auth check --provider openai-codex --json --no-refresh
```

It runs with the configured root in `PI_CODING_AGENT_DIR` and accepts only exact
`ready`/`openai-codex`/`oauth` JSON. Root-attested mode cannot detect an account switch
within the same root because Pi provides no supported stable non-secret account identity.
