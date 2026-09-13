# Epic Review Phase-End Template

```markdown
# Epic Review: Epic <ID> — [Title]

Generated: [date] | Issue provider: [provider] | Repository provider: [provider] Children: [IDs from
validated body links] | PRs: [explicit confirmed IDs] Evidence unavailable: [none or bounded
provider limitation/manual route]

## Summary

[2–3 professional sentences on health and reconciled Critical/Important/Minor totals]

## Critical

### [Category] — [Title]

- [ ] **Location/source:** `path:line` or Issue or PR ID
- **Finding:** [observable consequence]
- **Evidence:** [bounded proof]
- **Action:** [bounded correction]
- **Disposition:** Accepted | Deferred | Dropped

## Important

[Same shape]

## Minor

[Same shape]

## Unresolved Items

### Needs AFK Issue

- [ ] [title, confirmed scope, source, proposed parent/dependency body links]

### Needs HITL Issue

- [ ] [title, source, open decisions, proposed parent/dependency body links]

### Already Tracked

- [Issue ID — title — canonical URL] (no action needed)

## Documentation Updates

- [ ] [file — exact drift and required content]

## Architecture Promotion Candidates

- [title — evidence — recommendation for `/mp-architecture-review`]

## Execution Evidence

- [accepted item → executor result]
- [verification command → exit status/result]
- [follow-up ID/URL → body-link writeback result]

## Provider Limitations and Manual Handoff

- [provider role, unsupported/unavailable operation or evidence, exact safe next step]

## Final Status

[Complete | Deferred | Partial] — [remaining human action and confirmed Epic state]
```

Every finding appears exactly once; every actionable item has one checkbox; severity totals match;
unresolved work has one disposition. Keep dropped/deferred disposition visible. Record
`issues.provider` and `repository.provider` separately, native command evidence, deterministic
body-link status, and unavailable evidence. Exclude credentials, unrelated private discussion, and
inferred identity details.
