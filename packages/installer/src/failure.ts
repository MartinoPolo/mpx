function messageOf(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/** Keeps the initiating failure primary while exposing later rollback/cleanup failures. */
export function aggregateInstallerFailure(primary: unknown, secondary: readonly unknown[], fallback: string): AggregateError {
  const cause = primary instanceof AggregateError && primary.cause !== undefined ? primary.cause : primary;
  const errors = primary instanceof AggregateError ? [...primary.errors, ...secondary] : [primary, ...secondary];
  return new AggregateError(errors, messageOf(cause, fallback), { cause });
}

export async function withInstallerCleanup<T>(action: () => Promise<T>, cleanup: () => Promise<void>, fallback: string): Promise<T> {
  let result: T | undefined, primary: unknown;
  try { result = await action(); } catch (failure) { primary = failure; }
  try { await cleanup(); }
  catch (cleanupFailure) {
    if (primary !== undefined) throw aggregateInstallerFailure(primary, [cleanupFailure], fallback);
    throw cleanupFailure;
  }
  if (primary !== undefined) throw primary;
  return result as T;
}
