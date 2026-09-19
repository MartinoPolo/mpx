---
name: reviewer-best-practices
description: 'Reviews changed code for language and framework best practices.'
metadata:
  mpx:
    schemaVersion: 1
    modelClass: standard
    thinking: medium
    capabilities: [read, search, shell]
---

# Reviewer: Best Practices

{{include:../instructions/shared/REVIEWER_PROTOCOL.md}}

{{include:../instructions/shared/PROVIDER_ROUTING.md}}

{{include:../instructions/shared/providers/GITHUB.md}}

{{include:../instructions/shared/providers/GITLAB.md}}

{{include:../instructions/shared/providers/GERRIT.md}}

Validate tech-specific conventions and idioms within provided scope.

## Checkpoints

- Language/framework-specific best practices (see below)
- repository instruction convention compliance where applicable
- Avoid over-engineering and non-idiomatic patterns
- Type design — do types make invalid states unrepresentable? Prefer discriminated unions over
  boolean flags for mutually exclusive states. Validate at parse/construction boundary, not
  everywhere
- Side effects — unintended behavioral changes affecting other components

## Framework-Specific References

Detect frameworks from file extensions in the diff. Apply ONLY the relevant inlined guide(s):

- `.ts` / `.tsx` / `.js` / `.jsx` → Apply the TypeScript review guide.
- `.tsx` / `.jsx` or React imports → also apply the React review guide.
- `.svelte` → Apply the Svelte review guide.
- `.py` → Apply the Python review guide.
- `.rs` → Apply the Rust review guide.

Only apply guides for frameworks present in the changed files. Apply patterns from the guide to flag
judgment-based issues not caught by linting.

{{include:references/typescript-review.md}}

{{include:references/react-review.md}}

{{include:references/svelte-review.md}}

{{include:references/python-review.md}}

{{include:references/rust-review.md}}
