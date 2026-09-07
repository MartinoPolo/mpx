# `@mpx/subagents`

## Agent catalog V1 safety limits

Catalog parsing rejects the document with `AGENT_CATALOG_SCHEMA_INVALID` when an agent identity is longer than 128
UTF-16 code units, a nesting selector is longer than 256 UTF-16 code units, or one selector contains more than 16 `*`
wildcards. Agent identities remain ASCII-only, so identity and wildcard-result ordering uses JavaScript's
bytewise-equivalent default string sort.

Wildcard selectors are anchored to the complete identity. Only `*` is special; all other characters are matched
literally. Matching uses bounded dynamic programming rather than regular expressions, with at most 256 × 128
selector/candidate cells per comparison.

## Canonical agent document V1 safety limits

The neutral canonical loader accepts at most 128 direct `mpx-*.md` documents and 128 direct files beneath `references/`
(support depth is fixed at one). A document is limited to 1 MiB, `metadata.json` and each support file to 4 MiB, and all
canonical bytes together to 32 MiB. Inventory names use bytewise ordering. Roots and files must be contained, regular,
non-symlink paths and are read twice with unchanged size, timestamp, and bytes before they become verified renderer
capabilities.
