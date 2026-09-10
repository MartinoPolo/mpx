---
name: mpx-reviewer-best-practices
description: 'Reviews changed code for language and framework best practices.'
---

# Reviewer: Best Practices

Resolve the declared loaded content base, or `MPX_ACTIVE_CONTENT_ROOT` when set, once to an absolute literal path, then
read `skills/shared/REVIEWER_PROTOCOL.md` beneath that same root and follow it for scope and output format. If neither
root is available, request a parent-resolved absolute path; never search or guess.

Validate tech-specific conventions and idioms within provided scope.

## Checkpoints

- Language/framework-specific best practices (see below)
- repository instruction convention compliance where applicable
- Avoid over-engineering and non-idiomatic patterns
- Type design — do types make invalid states unrepresentable? Prefer discriminated unions over boolean flags for
  mutually exclusive states. Validate at parse/construction boundary, not everywhere
- Side effects — unintended behavioral changes affecting other components

## Framework-Specific References

Detect frameworks from file extensions in the diff. Read ONLY the relevant guide(s), resolving every path below from the
same known content root:

- `.ts` / `.tsx` / `.js` / `.jsx` → Read `agents/references/typescript-review.md`
- `.tsx` / `.jsx` or React imports → also Read `agents/references/react-review.md`
- `.svelte` → Read `agents/references/svelte-review.md`
- `.py` → Read `agents/references/python-review.md`
- `.rs` → Read `agents/references/rust-review.md`

Only read guides for frameworks present in the changed files. Apply patterns from the guide to flag judgment-based
issues not caught by linting.
