# `@mpx/subagents`

This package owns strict canonical agent catalog and document loading.

- Agent identities are bounded and ASCII-only.
- Wildcard selectors match complete identities with bounded dynamic programming; only `*` is special.
- Canonical agents are direct `mpx-*.md` files with one supported `references/` level.
- Counts, individual file sizes, and aggregate bytes are bounded.
- Roots and files must be contained, regular, and non-symlinked.
- Files are read twice and accepted only when metadata and bytes remain unchanged.

The root package exports catalog contracts and resolution. Canonical document loading is available through its dedicated public subpath and supplies verified inputs to the content compiler.
