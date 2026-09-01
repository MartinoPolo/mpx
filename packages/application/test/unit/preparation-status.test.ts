import { describe, expect, it } from 'vitest';
import { projectPreparationStatus } from '@mpx/application/node';

describe('projectPreparationStatus', () => {
  it('preserves every valid preparation status with an explicit lifecycle projection', () => {
    expect(
      (
        [
          'preparing',
          'cancelling',
          'ready',
          'failed',
          'cancelled',
          'unknown',
          'approval-required',
          'approved',
        ] as const
      ).map((status) => projectPreparationStatus(status)),
    ).toEqual([
      { preparationStatus: 'preparing', lifecycleStatus: 'preparing' },
      { preparationStatus: 'cancelling', lifecycleStatus: 'preparing' },
      { preparationStatus: 'ready', lifecycleStatus: 'ready' },
      {
        preparationStatus: 'failed',
        lifecycleStatus: 'failed',
        failure: {
          phase: 'preparation',
          code: 'PREPARATION_FAILED',
          message: 'Preparation failed.',
        },
      },
      {
        preparationStatus: 'cancelled',
        lifecycleStatus: 'failed',
        failure: {
          phase: 'preparation',
          code: 'PREPARATION_CANCELLED',
          message: 'Preparation was cancelled.',
        },
      },
      {
        preparationStatus: 'unknown',
        lifecycleStatus: 'unknown',
        failure: {
          phase: 'preparation',
          code: 'PREPARATION_UNKNOWN',
          message: 'Preparation ownership or completion could not be verified.',
        },
      },
      { preparationStatus: 'approval-required', lifecycleStatus: 'approval-required' },
      { preparationStatus: 'approved', lifecycleStatus: 'preparation-pending' },
    ]);
  });

  it('rejects an unrecognized runtime status instead of treating it as failed', () => {
    expect(() => Reflect.apply(projectPreparationStatus, undefined, ['corrupted'])).toThrow(
      'Unrecognized preparation status: corrupted',
    );
  });
});
