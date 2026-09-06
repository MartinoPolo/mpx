# Pi account enrollment

Pi account roots are configured only in strict user config. CLI commands never accept a root, and `LOCALAPPDATA` must be an absolute path.

Run the canonical setup flow after configuring the identity and its Pi runtime root:

```text
mpx setup
```

Setup verifies the trusted Pi executable and live OAuth availability before committing the immutable installation. Re-running setup preserves the opaque references used by native session bindings.

The private atomic registry stores only schema version, opaque reference, identity, runtime `pi`, canonical root digest, `root-attested` mode, and timestamps. Public output omits the root path and opaque reference. MPX never reads `auth.json`, requests credentials or tokens, decodes JWTs, or retains probe output.

The supported internal probe is exactly:

```text
auth check --provider openai-codex --json --no-refresh
```

It runs with the configured root in `PI_CODING_AGENT_DIR` and accepts only exact `ready`/`openai-codex`/`oauth` JSON. Root-attested mode cannot detect an account switch within the same root because Pi provides no supported stable non-secret account identity.
