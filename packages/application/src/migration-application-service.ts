export type MigrationAction = 'reconcile' | 'report' | 'rollback-drill' | 'cutover-plan';

export interface MigrationApplicationRequest {
  readonly action: MigrationAction;
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly legacyDisabled: boolean;
}

export interface MigrationExecutionPort {
  execute(request: MigrationApplicationRequest): Promise<unknown>;
}

export class MigrationApplicationService {
  constructor(private readonly execution: MigrationExecutionPort) {}

  execute(request: MigrationApplicationRequest): Promise<unknown> {
    return this.execution.execute(request);
  }
}
