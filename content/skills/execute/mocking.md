# Test Doubles

Use mocks, fakes, or controlled implementations when they make a relevant boundary deterministic,
safe, or practical. Typical cases include external services, time, randomness, unavailable
infrastructure, and expensive resources. Prefer a realistic collaborator when it is reliable,
proportionate, and gives stronger evidence.

Choose the smallest interface that expresses the behavior the caller needs. Keep test setup focused
on inputs and observable outcomes. Avoid doubles that reproduce implementation logic or assertions
about incidental internal calls, order, or counts. A collaborator's ownership alone does not decide
whether replacing it is appropriate; judge the boundary and the evidence required by the test.
