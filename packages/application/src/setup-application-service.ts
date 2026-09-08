import { MpxError } from '@mpx/core';
import type {
  InstallIntentBuilder,
  InstallOrchestrator,
  InstallVerificationV1,
  CurrentInstallationProbe,
} from '@mpx/installer';

export interface SetupRequestFactory {
  create(): Promise<unknown>;
}

export interface SetupResultV1 {
  readonly schemaVersion: 1;
  readonly kind: 'setup-result';
  readonly releaseKey: string;
  readonly verification: {
    readonly healthy: boolean;
    readonly issues: readonly string[];
  };
}

export interface SetupApplicationDependencies {
  readonly requestFactory: SetupRequestFactory;
  readonly localReset: { run(): Promise<void> };
  readonly detach: { run(): Promise<void> };
  readonly legacyPiExtensionsCleanup: { run(): Promise<void> };
  readonly builder: Pick<InstallIntentBuilder, 'build'>;
  readonly installationProbe: CurrentInstallationProbe;
  readonly orchestrator: Pick<
    InstallOrchestrator,
    'admitCurrentInstallation' | 'plan' | 'apply' | 'verify'
  >;
}

export class SetupApplicationService {
  constructor(private readonly dependencies: SetupApplicationDependencies) {}

  async execute(): Promise<SetupResultV1> {
    const request = await this.dependencies.requestFactory.create();
    const built = await this.dependencies.builder.build(request);
    const admission = await this.dependencies.orchestrator.admitCurrentInstallation(
      built.intent,
      this.dependencies.installationProbe,
    );
    if (admission.status === 'initial') {
      await this.dependencies.localReset.run();
      await this.dependencies.detach.run();
    }
    await this.dependencies.legacyPiExtensionsCleanup.run();
    const plan = await this.dependencies.orchestrator.plan(built.intent, admission);
    await this.dependencies.orchestrator.apply(plan, plan.confirmationDigest);
    const verified: InstallVerificationV1 = await this.dependencies.orchestrator.verify(true);
    if (!verified.healthy) {
      throw new MpxError({
        code: 'SETUP_VERIFICATION_FAILED',
        message: 'Setup verification failed.',
        details: { issues: [...verified.issues] },
        retryable: true,
        remediation: 'Retry mpx setup and inspect mpx doctor --json.',
      });
    }
    return {
      schemaVersion: 1,
      kind: 'setup-result',
      releaseKey: built.intent.releaseKey,
      verification: { healthy: verified.healthy, issues: [...verified.issues] },
    };
  }
}
