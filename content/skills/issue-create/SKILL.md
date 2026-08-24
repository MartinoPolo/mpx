---
name: issue-create
description: Create a clear provider-neutral Issue from confirmed intent
triggers: creating or recording an Issue
metadata:
  mpx:
    skillPacks: [core]
    defaultExposure: name-only
---
# Create an Issue

Create one well-scoped Issue without selecting or addressing a provider directly.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Confirm the title, problem, desired outcome, acceptance criteria, and relevant constraints. Ask only for missing information that changes the result.
2. Keep implementation details out unless they are confirmed constraints. Use the public term Issue.
3. Run `mpx issue create --identity <launch-identity> --json` with the confirmed fields.
4. Read the structured response. Report the created Issue identifier and canonical URL when present.
5. Do not claim creation unless the response confirms success.

## Unsupported capability

If the JSON response has `ok: false` and `error.code: CAPABILITY_UNSUPPORTED`, stop the create operation. Report the unsupported capability and any structured remediation. Do not invoke or suggest a direct provider command as a fallback.

For every other structured error, report the code and actionable message, then stop rather than guessing that the Issue exists.
