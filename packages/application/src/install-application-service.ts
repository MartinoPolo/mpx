import { MpxError } from '@mpx/core';
import type {
  InstallIntentBuildResultV1,
  InstallIntentBuilder,
  InstallIntentV1,
  InstallOrchestrator,
  InstallPlanV1,
} from '@mpx/installer';

export interface InstallProtocolInputPort {
  request(source: string): Promise<unknown>;
  intent(source: string): Promise<InstallIntentV1 | InstallIntentBuildResultV1>;
  plan(source: string): Promise<InstallPlanV1>;
  buildResult(source: string): Promise<InstallIntentBuildResultV1>;
  evidence(source: string): Promise<unknown>;
}

export type InstallApplicationRequest =
  | { readonly action: 'intent' | 'prepare'; readonly request?: string }
  | { readonly action: 'plan'; readonly intent?: string }
  | { readonly action: 'apply'; readonly plan?: string; readonly confirmation?: string }
  | {
      readonly action: 'verify';
      readonly strict: boolean;
      readonly externalPlan?: string;
    }
  | { readonly action: 'rollback'; readonly transaction?: string; readonly confirmation?: string }
  | { readonly action: 'uninstall'; readonly confirmation?: string };

export interface InstallApplicationDependencies {
  readonly input: InstallProtocolInputPort;
  readonly orchestrator: Pick<
    InstallOrchestrator,
    'plan' | 'apply' | 'verify' | 'rollback' | 'uninstall'
  >;
  readonly builder?: () => Pick<InstallIntentBuilder, 'build' | 'verify'>;
}

function fail(message: string): never {
  throw new MpxError({ code: 'INSTALL_USAGE_ERROR', message });
}

function required(value: string | undefined, option: string): string {
  return value ?? fail(`--${option} is required`);
}

export class InstallApplicationService {
  constructor(private readonly dependencies: InstallApplicationDependencies) {}

  private builder(): Pick<InstallIntentBuilder, 'build' | 'verify'> {
    return (
      this.dependencies.builder?.() ?? fail('install intent and prepare require an intent builder')
    );
  }

  async execute(request: InstallApplicationRequest): Promise<unknown> {
    if (request.action === 'intent' || request.action === 'prepare') {
      const source = await this.dependencies.input.request(required(request.request, 'request'));
      const built = await this.builder().build(source);
      return request.action === 'prepare'
        ? this.dependencies.orchestrator.plan(built.intent)
        : built;
    }
    if (request.action === 'plan') {
      const source = await this.dependencies.input.intent(required(request.intent, 'intent'));
      const intent = source.kind === 'install-intent-build-result' ? source.intent : source;
      return this.dependencies.orchestrator.plan(intent);
    }
    if (request.action === 'apply') {
      const plan = await this.dependencies.input.plan(required(request.plan, 'plan'));
      const receipt = await this.dependencies.orchestrator.apply(
        plan,
        required(request.confirmation, 'confirm-plan'),
      );
      return { schemaVersion: 1, kind: 'install-apply', receipt };
    }
    if (request.action === 'verify') {
      const externalPlan = request.externalPlan
        ? await this.dependencies.input.buildResult(request.externalPlan)
        : undefined;
      const externalSource = externalPlan ? () => this.builder().verify(externalPlan) : undefined;
      return this.dependencies.orchestrator.verify(request.strict, externalSource);
    }
    if (request.action === 'rollback') {
      return this.dependencies.orchestrator.rollback(
        required(request.transaction, 'transaction'),
        required(request.confirmation, 'confirm-plan'),
      );
    }
    if (request.action === 'uninstall') {
      return this.dependencies.orchestrator.uninstall(
        required(request.confirmation, 'confirm-plan'),
      );
    }
    return fail('Unsupported install application request.');
  }
}
