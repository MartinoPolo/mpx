import type { LifecycleFailure, LifecycleStatus, PreparationStatus } from '@mpx/worktrees';

export type PublicPreparationStatus = PreparationStatus | 'approval-required' | 'approved';

export interface PreparationLifecycleProjection {
  readonly preparationStatus: PublicPreparationStatus;
  readonly lifecycleStatus: LifecycleStatus;
  readonly failure?: LifecycleFailure;
}

function assertNeverStatus(status: never): never {
  throw new Error(`Unrecognized preparation status: ${String(status)}`);
}

/** Exhaustively projects public preparation outcomes onto durable lifecycle state. */
export function projectPreparationStatus(
  status: PublicPreparationStatus,
): PreparationLifecycleProjection {
  switch (status) {
    case 'ready':
      return { preparationStatus: status, lifecycleStatus: 'ready' };
    case 'preparing':
    case 'cancelling':
      return { preparationStatus: status, lifecycleStatus: 'preparing' };
    case 'approval-required':
      return { preparationStatus: status, lifecycleStatus: 'approval-required' };
    case 'approved':
      return { preparationStatus: status, lifecycleStatus: 'preparation-pending' };
    case 'unknown':
      return {
        preparationStatus: status,
        lifecycleStatus: 'unknown',
        failure: {
          phase: 'preparation',
          code: 'PREPARATION_UNKNOWN',
          message: 'Preparation ownership or completion could not be verified.',
        },
      };
    case 'cancelled':
      return {
        preparationStatus: status,
        lifecycleStatus: 'failed',
        failure: {
          phase: 'preparation',
          code: 'PREPARATION_CANCELLED',
          message: 'Preparation was cancelled.',
        },
      };
    case 'failed':
      return {
        preparationStatus: status,
        lifecycleStatus: 'failed',
        failure: {
          phase: 'preparation',
          code: 'PREPARATION_FAILED',
          message: 'Preparation failed.',
        },
      };
    default:
      return assertNeverStatus(status);
  }
}
