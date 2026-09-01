import type { IdentityConfig, ProjectConfig } from '@mpx/config';
import { MpxError, type JsonValue } from '@mpx/core';
import {
  capabilitiesForProviderRole,
  type ProviderCapability,
  type ProviderDescriptor,
  type ProviderInvocation,
  type ProviderProbeRequest,
  type ProviderProbeResult,
  type ProviderRole,
} from '@mpx/providers';
import type { ApplicationOperationResult } from './contracts.js';

export interface ProviderRegistryOperations {
  list(role?: ProviderRole): readonly ProviderDescriptor[];
  get(id: string, role?: ProviderRole): ProviderDescriptor;
  assertCapability(id: string, capability: string): void;
}

export interface ProviderInvoker {
  invoke(request: ProviderInvocation): Promise<unknown>;
}

export interface ProviderServiceFactoryRequest {
  readonly project: ProjectConfig;
  readonly providerId: string;
  readonly capability: string;
  readonly cwd?: string;
}

export interface ProviderRoutePolicyRequest {
  readonly providerId: string;
  readonly role: ProviderRole;
  readonly capabilities: readonly ProviderCapability[];
}

export interface ProviderRoutePolicy {
  requiresRoute(request: ProviderRoutePolicyRequest): boolean;
}

export interface ProviderApplicationDependencies {
  readonly registry: ProviderRegistryOperations;
  readonly routePolicy: ProviderRoutePolicy;
  createProviderService(
    request: ProviderServiceFactoryRequest,
  ): Promise<ProviderInvoker> | ProviderInvoker;
  probe(request: ProviderProbeRequest): Promise<ProviderProbeResult>;
}

export interface ProviderPrepareInvocationRequest {
  readonly project: ProjectConfig;
  readonly role: ProviderRole;
  readonly capability: string;
  readonly identityName?: string;
  readonly identity?: IdentityConfig;
  readonly cwd?: string;
}

export interface PreparedProviderInvocation {
  readonly providerId: string;
  readonly role: ProviderRole;
  readonly capability: ProviderCapability;
  readonly route?: string;
}

interface PreparedProviderInvocationState {
  readonly project: ProjectConfig;
  readonly cwd?: string;
  readonly providerId: string;
  readonly role: ProviderRole;
  readonly capability: ProviderCapability;
  readonly route?: string;
}

export interface ProviderExplainData {
  readonly role: ProviderRole;
  readonly provider: string;
  readonly adapter: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly route: null;
  readonly routeSelection: 'identity-required';
}

export type ProviderDoctorEntry = Readonly<{
  role: ProviderRole;
  provider: string;
  backend: string;
  capabilities: readonly ProviderCapability[];
  route: string | null;
}> &
  ProviderProbeResult;

export interface ProviderDoctorData {
  readonly schemaVersion: 1;
  readonly identity: string;
  readonly providers: readonly ProviderDoctorEntry[];
}

const selectedProvider = (project: ProjectConfig, role: ProviderRole): string =>
  role === 'repository' ? project.repository.provider : (project.issues?.provider ?? 'none');

const operationError = (
  code: string,
  message: string,
  options: { capability?: string; remediation?: string } = {},
): MpxError => new MpxError({ code, message, ...options });

export class ProviderApplicationService {
  readonly #prepared = new WeakMap<PreparedProviderInvocation, PreparedProviderInvocationState>();

  constructor(private readonly dependencies: ProviderApplicationDependencies) {}

  list(
    request: { role?: ProviderRole } = {},
  ): ApplicationOperationResult<readonly ProviderDescriptor[]> {
    return { data: this.dependencies.registry.list(request.role) };
  }

  explain(request: {
    project: ProjectConfig;
    role: ProviderRole;
  }): ApplicationOperationResult<ProviderExplainData> {
    const descriptor = this.dependencies.registry.get(
      selectedProvider(request.project, request.role),
      request.role,
    );
    return {
      data: {
        role: request.role,
        provider: descriptor.id,
        adapter: descriptor.backend,
        capabilities: capabilitiesForProviderRole(descriptor.capabilities, request.role),
        route: null,
        routeSelection: 'identity-required',
      },
    };
  }

  prepareInvocation(request: ProviderPrepareInvocationRequest): PreparedProviderInvocation {
    const providerId = selectedProvider(request.project, request.role);
    const descriptor = this.dependencies.registry.get(providerId, request.role);
    this.dependencies.registry.assertCapability(providerId, request.capability);
    const roleCapabilities = capabilitiesForProviderRole(descriptor.capabilities, request.role);
    if (!roleCapabilities.includes(request.capability as ProviderCapability)) {
      throw operationError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        `Provider '${providerId}' does not support capability '${request.capability}' for role '${request.role}'.`,
        { capability: request.capability },
      );
    }
    const routeRequired = this.dependencies.routePolicy.requiresRoute({
      providerId,
      role: request.role,
      capabilities: roleCapabilities,
    });
    const route = request.identity?.providerRoutes?.[providerId];
    if (routeRequired && request.identityName === undefined) {
      throw operationError('IDENTITY_REQUIRED', 'Provider commands require an explicit identity.');
    }
    if (routeRequired && request.identity === undefined) {
      throw operationError('IDENTITY_UNKNOWN', `Unknown identity '${request.identityName}'.`);
    }
    if (routeRequired && route === undefined) {
      throw operationError(
        'PROVIDER_ROUTE_REQUIRED',
        `Identity '${request.identityName}' has no route for provider '${providerId}'.`,
        { remediation: 'Configure identity.providerRoutes for the selected provider.' },
      );
    }
    this.authorizeWorkflow(request.project, request.capability);
    const state: PreparedProviderInvocationState = {
      project: request.project,
      providerId,
      role: request.role,
      capability: request.capability as ProviderCapability,
      ...(route === undefined ? {} : { route }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    };
    const preparedTarget: PreparedProviderInvocation = Object.freeze({
      providerId,
      role: request.role,
      capability: state.capability,
      ...(route === undefined ? {} : { route }),
    });
    const prepared: PreparedProviderInvocation = new Proxy(preparedTarget, {
      set: () => {
        throw new TypeError('Prepared provider invocations are immutable.');
      },
      defineProperty: () => {
        throw new TypeError('Prepared provider invocations are immutable.');
      },
      deleteProperty: () => {
        throw new TypeError('Prepared provider invocations are immutable.');
      },
    });
    this.#prepared.set(prepared, state);
    return prepared;
  }

  async invokePrepared(
    prepared: PreparedProviderInvocation,
    input: JsonValue,
  ): Promise<ApplicationOperationResult<unknown>> {
    const state = this.#prepared.get(prepared);
    if (state === undefined) {
      throw operationError(
        'INVALID_PREPARED_INVOCATION',
        'The prepared provider invocation is invalid.',
      );
    }
    const provider = await this.dependencies.createProviderService({
      project: state.project,
      providerId: state.providerId,
      capability: state.capability,
      ...(state.cwd === undefined ? {} : { cwd: state.cwd }),
    });
    const data = await provider.invoke({
      providerId: state.providerId,
      capability: state.capability,
      ...(state.route === undefined ? {} : { route: state.route }),
      input,
    });
    return { data };
  }

  async doctor(request: {
    project: ProjectConfig;
    identityName?: string;
    identity?: IdentityConfig;
    cwd?: string;
  }): Promise<ApplicationOperationResult<ProviderDoctorData>> {
    if (request.identityName === undefined) {
      throw operationError('IDENTITY_REQUIRED', 'Provider doctor requires an explicit identity.');
    }
    if (request.identity === undefined) {
      throw operationError('IDENTITY_UNKNOWN', `Unknown identity '${request.identityName}'.`);
    }
    const identityName = request.identityName;
    const identity = request.identity;
    const selections: readonly [ProviderRole, string][] = [
      ['issues', selectedProvider(request.project, 'issues')],
      ['repository', selectedProvider(request.project, 'repository')],
    ];
    const providers = await Promise.all(
      selections.map(async ([role, provider]) => {
        const descriptor = this.dependencies.registry.get(provider, role);
        const capabilities = capabilitiesForProviderRole(descriptor.capabilities, role);
        const route = identity.providerRoutes?.[provider];
        if (
          this.dependencies.routePolicy.requiresRoute({
            providerId: provider,
            role,
            capabilities,
          }) &&
          route === undefined
        ) {
          throw operationError(
            'PROVIDER_ROUTE_REQUIRED',
            `Identity '${identityName}' has no route for provider '${provider}'.`,
            { remediation: 'Configure identity.providerRoutes for the selected provider.' },
          );
        }
        const probe = await this.dependencies.probe({
          providerId: provider,
          role,
          ...(route === undefined ? {} : { route }),
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        });
        return {
          role,
          provider,
          backend: descriptor.backend,
          capabilities,
          route: route ?? null,
          ...probe,
        } satisfies ProviderDoctorEntry;
      }),
    );
    return {
      data: { schemaVersion: 1, identity: identityName, providers },
      exitCode: providers.some((provider) => provider.status === 'error') ? 1 : 0,
    };
  }

  private authorizeWorkflow(project: ProjectConfig, capability: string): void {
    const codeReview = project.workflow?.codeReview;
    if (capability === 'review.ready' && codeReview?.markReady === 'human') {
      throw operationError(
        'WORKFLOW_POLICY_DENIED',
        'Project workflow policy requires a human to mark reviews ready.',
        { capability },
      );
    }
    if (capability === 'review.merge' && codeReview?.merge === 'human') {
      throw operationError(
        'WORKFLOW_POLICY_DENIED',
        'Project workflow policy requires a human to merge reviews.',
        { capability },
      );
    }
  }
}

export const createProviderApplicationService = (
  dependencies: ProviderApplicationDependencies,
): ProviderApplicationService => new ProviderApplicationService(dependencies);
