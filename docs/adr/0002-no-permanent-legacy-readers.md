# ADR 0002: No permanent legacy readers

- Status: Accepted

Legacy installations and data remain available for rollback during migration, but normal MPX operation never reads legacy worktree, port, provider, status-line, or session configuration. Explicit one-time import commands may read legacy state non-destructively and record provenance.
