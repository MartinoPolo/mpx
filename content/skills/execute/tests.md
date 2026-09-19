# Testing Guidance

- Understand the requirements and design reasonable test coverage from the agreed behavior, important failure modes, and known regressions. Coverage should be useful and proportional to the change and its risk.
- Prefer existing coverage. Add or update tests where they meaningfully verify the behavioral change.
- Test through public interfaces and derive expected results from the requirements.
- Use assertions that remain valid when implementation details change while behavior stays the same. Asserting a specific CSS value is usually discouraged. Significant exception can occur.
- Use meaningful end-to-end tests for user-facing behavior. Prefer Playwright for browser verification.
- When an automated test would add little value, report the alternative verification performed.
- In TDD mode, confirm that the test fails because the required behavior is missing, then implement the behavior and confirm it passes.
- Prioritize the new acceptance criteria when requirements change. Update or retire conflicting tests and report material changes to existing coverage.

Do not create tests merely to satisfy a process label. Avoid source-text or CSS-presence assertions
and expected values that duplicate implementation logic. Existing tests are evidence, not immutable
specification.

`--no-tdd` excludes creating tests during implementation, not running existing tests during
verification. Required updates or retirement of obsolete existing tests follow the acceptance
criteria and must be reported.
