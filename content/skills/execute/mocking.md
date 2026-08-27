# Execute Mocking Guidance

Mock only boundaries that are slow, nondeterministic, destructive, unavailable in tests, or outside the process. Prefer real domain objects and in-memory implementations for owned logic.

A mock must preserve the relevant contract, including structured failures. Assert observable output or state first; assert interactions only when the interaction itself is the behavior (for example, no provider call after denial).

Do not mock the unit under test, duplicate production algorithms in fixtures, return unrealistically perfect values, or let provider-specific response shapes leak across the MPX capability boundary. Use GitHub, GitLab, and unsupported fixtures to prove provider-neutral behavior and `CAPABILITY_UNSUPPORTED` remediation without invoking provider CLIs.
