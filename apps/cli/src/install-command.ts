import type { InstallApplicationRequest, InstallApplicationService } from '@mpx/application';
import { MpxError } from '@mpx/core';

export interface InstallCommandInput {
  readonly action: string | undefined;
  readonly args: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean | string[]>;
}

export interface InstallCommandContext {
  readonly application: Pick<InstallApplicationService, 'execute'>;
}

const value = (input: InstallCommandInput, name: string): string | undefined => {
  const found = input.options.get(name);
  return typeof found === 'string' ? found : undefined;
};

const fail = (message: string): never => {
  throw new MpxError({ code: 'INSTALL_USAGE_ERROR', message });
};

function request(input: InstallCommandInput): InstallApplicationRequest {
  if (input.action === 'intent' || input.action === 'prepare') {
    const source = value(input, 'request');
    return {
      action: input.action,
      ...(source !== undefined ? { request: source } : {}),
    };
  }
  if (input.action === 'plan') {
    const source = value(input, 'intent');
    return { action: 'plan', ...(source !== undefined ? { intent: source } : {}) };
  }
  if (input.action === 'apply') {
    const plan = value(input, 'plan'),
      confirmation = value(input, 'confirm-plan');
    return {
      action: 'apply',
      ...(plan !== undefined ? { plan } : {}),
      ...(confirmation !== undefined ? { confirmation } : {}),
    };
  }
  if (input.action === 'verify') {
    const externalPlan = value(input, 'external-plan');
    return {
      action: 'verify',
      strict: input.options.get('strict') === true,
      ...(externalPlan !== undefined ? { externalPlan } : {}),
    };
  }
  if (input.action === 'rollback') {
    const transaction = value(input, 'transaction'),
      confirmation = value(input, 'confirm-plan');
    return {
      action: 'rollback',
      ...(transaction !== undefined ? { transaction } : {}),
      ...(confirmation !== undefined ? { confirmation } : {}),
    };
  }
  if (input.action === 'uninstall') {
    const confirmation = value(input, 'confirm-plan');
    return {
      action: 'uninstall',
      ...(confirmation !== undefined ? { confirmation } : {}),
    };
  }
  return fail('install requires intent, prepare, plan, apply, verify, rollback, or uninstall');
}

export async function executeInstallCommand(
  input: InstallCommandInput,
  context: InstallCommandContext,
): Promise<{ data: unknown }> {
  if (input.args.length) {
    fail('install commands accept no positional arguments');
  }
  return { data: await context.application.execute(request(input)) };
}
