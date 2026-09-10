# Installation and launch mechanics

These are project-local Windows orchestration instructions. Read the current checkout’s `docs/INSTALLATION.md` and
`docs/LAUNCH.md` before execution; if their contracts have changed, stop and report the mismatch rather than invent flags.

## Installation preflight

Resolve `MPX_APPS` and the Windows `LOCALAPPDATA` environment variable. Require absolute paths. The installed selector is
`LOCALAPPDATA` + `mpx/active-release`; the selected release is beneath `MPX_APPS` + `mpx/releases/<release-key>/` and has
`release-manifest.json`. Validate the selector as a SHA-256 key before constructing the release path. Require regular,
non-link selector/manifest files and a non-link release directory; verify resolved release and manifest paths remain
beneath the resolved `MPX_APPS/mpx/releases` root before reading them. Unsafe or ambiguous paths are `unverified`.
Read only these bounded installation records, not account credentials or unrelated machine state.

The public workspace API `readActiveRelease(localAppData)` from `@mpx/installer` validates the selector when that package
is already available in the checkout. Its absence is not permission to build dependencies during the preflight.

- Missing selection or release: `missing`.
- A demonstrated difference in corresponding shipped source bytes: `stale`.
- Valid installed records plus verified build provenance tying the selected release to the complete current checkout:
  `current`.
- Missing provenance, stale/missing generated bundles, malformed records, or insufficient comparison evidence:
  `unverified`, with the exact reason.

Use the installed manifest to identify corresponding shipped files; do not maintain a separate release-file inventory.
The immutable manifest proves installed content identity, not that generated CLI/extension bundles represent today’s
source. Matching a package version, Git HEAD, modification time, or existing bundle is insufficient. Do not improvise a
new build-provenance scheme inside this skill or perform a broad source audit to resolve uncertainty.

The current public CLI has no read-only checkout-versus-installed freshness command. `mpx setup` is a mutating repair of
the installed release, not a freshness probe and not a way to install checkout changes. The explicit approval branch
uses `pnpm run setup`, which builds, publishes, selects, and strictly verifies the current checkout. Stop on any failure;
do not use `pnpm setup`, install dependencies, or run a substitute setup entry point.

Authoritative repository references: `docs/INSTALLATION.md`, `packages/installer/src/immutable-core.ts`, and
`packages/installer/src/orchestration.ts`. Refer to their current contracts when evaluating evidence, not historical
session claims. If source changes concurrently with installation, freshness remains unverified.

## Fresh managed launches

The following Bash templates assume `TARGET_PROJECT` and `RUN_DIRECTORY` have already been resolved to validated literal
absolute paths. `RUN_DIRECTORY/prompt.md` is the unchanged snapshot from the source repository. Set `IDENTITY` from the
matrix, not from project location. Quote paths; do not expect file tools to expand shell variables.

First verify `mpx` is executable on the current PATH. Missing CLI availability is an orchestration failure; do not use a
checkout binary, guessed launcher, or native account alias instead.

Pi, for each Pi matrix row:

```bash
mpx launch pi --cwd "$TARGET_PROJECT" \
  --identity "$IDENTITY" --executor host --workspace direct \
  --reason 'Run project-local MPX verification' --approve-host \
  --runtime-arg=--provider --runtime-arg=openai-codex \
  --runtime-arg=--model --runtime-arg=gpt-5.6-luna \
  --runtime-arg=--mode --runtime-arg=json --runtime-arg=--print \
  < "$RUN_DIRECTORY/prompt.md"
```

Claude, for the work-Claude matrix row:

```bash
mpx launch claude --cwd "$TARGET_PROJECT" \
  --identity work --executor host --workspace direct \
  --reason 'Run project-local MPX verification' --approve-host \
  --runtime-arg=--model --runtime-arg=haiku \
  --runtime-arg=--print --runtime-arg=--output-format --runtime-arg=json \
  < "$RUN_DIRECTORY/prompt.md"
```

Invoke each through a bounded foreground process runner, capturing output into separate files named for the matrix row.
Host approval is scoped to this diagnostic launch; it does not bypass the child runtime’s tool permissions. Do not add
`--no-session`, resume options, trust overrides, or permission-bypass flags.

MPX appends native runtime arguments after its own arguments. Duplicate model-option precedence is not an MPX guarantee:
check the emitted runtime evidence before calling model selection successful. Pi JSON output is an event stream; Claude
print JSON returns a result envelope. Preserve the native stream/envelope and separately extract the final report. MPX
`--json` is not a replacement for native output-format flags. Do not assume launch diagnostics are native JSON records;
retain unparsed diagnostics and record malformed/incomplete native output rather than discarding it.

Native documentation:

- Pi: use the active installation’s README sections “CLI Reference” and “Modes” for `--print`, JSON mode, and stdin input.
- Claude: [CLI reference](https://code.claude.com/docs/en/cli-reference) and
  [headless usage](https://code.claude.com/docs/en/headless) document print mode, stdin input, model aliases, and JSON output.

Do not run another model just to interpret reports. The orchestrating agent summarizes the captured results directly.
