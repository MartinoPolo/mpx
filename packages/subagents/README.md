# `@mpx/subagents`

## Agent catalog V1 safety limits

Catalog parsing rejects the document with `AGENT_CATALOG_SCHEMA_INVALID` when an agent identity is longer than 128 UTF-16 code units, a nesting selector is longer than 256 UTF-16 code units, or one selector contains more than 16 `*` wildcards. Agent identities remain ASCII-only, so identity and wildcard-result ordering uses JavaScript's bytewise-equivalent default string sort.

Wildcard selectors are anchored to the complete identity. Only `*` is special; all other characters are matched literally. Matching uses bounded dynamic programming rather than regular expressions, with at most 256 × 128 selector/candidate cells per comparison.
