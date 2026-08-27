# Execute Test Design

A good test proves one acceptance behavior through the narrowest stable public boundary.

## Red-green-refactor

1. Write one focused test naming the observable outcome.
2. Run the smallest relevant command and confirm failure for the expected missing behavior. A passing test means coverage already exists; record that evidence rather than forcing a failure.
3. Implement the minimum production correction. Never weaken assertions or rewrite a valid test merely to pass.
4. Refactor names, duplication, and structure only while the focused test remains green.
5. Run neighboring and repository-prescribed suites after focused success.

Prefer deterministic inputs, behavior assertions, and existing test helpers. Avoid asserting private call order, exact implementation structure, incidental formatting, or broad snapshots when a specific assertion explains the contract. Cover boundary and error behavior when acceptance criteria require it. Keep unrelated cleanup out of the test change.
