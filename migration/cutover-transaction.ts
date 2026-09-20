export async function applyPreparedCutover(
  operations: readonly (() => Promise<void>)[],
  recover: () => Promise<void>,
): Promise<void> {
  try {
    for (const operation of operations) await operation();
  } catch (error) {
    try {
      await recover();
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], 'Cutover failed; recovery incomplete. Preserve the backup for manual inspection.');
    }
    throw error;
  }
}
