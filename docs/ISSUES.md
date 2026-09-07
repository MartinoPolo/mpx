# Issue, Review, and CI operations

MPX does not provide `mpx issue`, `mpx review`, or `mpx ci` commands. Canonical skills use shipped native-command references after validating the nearest `mpxconfig.json`.

- `issues.provider` selects Issue and board behavior.
- `repository.provider` selects Review, CI, and repository behavior.
- An invalid nearer manifest is an error; resolution never falls through to an ancestor.
- Project manifests contain no account or identity selection.

The provider ID maps directly to a reference under `content/instructions/shared/providers`. Those references contain the supported, tested native syntax and explicit target requirements for `gh`, `glab`, `kf`, Gerrit Git/SSH, or local Markdown files. Skills must not guess flags, switch native authentication, infer targets from an account, or invent unsupported operations.

Local Issue stores preserve the schema-v2 Markdown format and schema-v1 index described in [Local Markdown issues](local-markdown-issues.md). Hosted provider output remains native output; there is no MPX-normalized provider envelope.

Mutations require the calling skill's authorization. Merge requires fresh human authorization. Unsupported capabilities produce a bounded manual handoff without discarding already confirmed work.
