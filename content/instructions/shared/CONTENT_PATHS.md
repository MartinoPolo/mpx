# Canonical Content Paths

## Markdown links

Keep links between canonical Markdown files relative. The content compiler follows those links, includes their closure,
and preserves a runtime-resolvable projection. Resolve a link relative to the compiled file containing it before using
any fallback.

## Runtime tool paths

When `Read` or a shell command needs a literal absolute path, read `MPX_ACTIVE_CONTENT_ROOT` once from the process
environment, validate that it is set and absolute, and resolve the canonical projection-relative path beneath it. Verify
the result exists, remains contained by that root, and is unambiguous. Store and reuse that resulting absolute path for
the session; pass the literal resolved path to `Read` or bash.

Environment variables written in Markdown are text. Tool path parameters do not reliably perform shell expansion, and
`$VAR`, `${VAR}`, and `%VAR%` must not be passed as though `Read` will expand them. Shell expansion occurs only inside a
shell and depends on its syntax. Resolve first, then pass the resulting literal. Do not invent `MPX_PATH`, guess an
installation checkout, or commit a machine-specific absolute path.

If `MPX_ACTIVE_CONTENT_ROOT` is unset, non-absolute, outside the trusted launch, or does not contain the requested file,
stop and name the failed condition. Do not search personal machine roots for a substitute canonical-content
installation.

## Other machine roots

For non-content files, use only the documented `MPX_*` variable that semantically owns the location. Read it from the
runtime environment, require an absolute path, append the requested relative path, and preserve containment. Never guess
a user profile, drive, checkout, or working directory fallback. Variables used in prose are instructions to resolve at
runtime, not compiler placeholders.
