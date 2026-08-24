import type { JsonValue } from "@mpx/core";
import type { ProviderCapabilityInputMap, ProviderCapabilityOutputMap } from "./contracts.js";
import {
  ProviderError, type ProviderCapability, type ProviderRole, type ProviderRegistry, type TrustedBackendId,
} from "./registry.js";

export interface ProviderInvocation {
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly route?: string;
  readonly input: JsonValue;
}

export type ProviderServiceInvocation<Capability extends ProviderCapability> = Readonly<{
  providerId: string;
  capability: Capability;
  route?: string;
  input: ProviderCapabilityInputMap[Capability];
}>;

export interface ProviderAdapter {
  readonly providerId: string;
  readonly role: ProviderRole;
  readonly backend: TrustedBackendId;
  readonly capabilities: readonly ProviderCapability[];
  readonly routeRequired: boolean;
  invoke(request: ProviderInvocation): Promise<unknown>;
}

const roleFor = (capability: ProviderCapability): ProviderRole => capability.startsWith("issue.") ? "issues" : "repository";
const keyFor = (providerId: string, role: ProviderRole): string => `${providerId}:${role}`;
const sameCapabilities = (left: readonly ProviderCapability[], right: readonly ProviderCapability[]): boolean =>
  left.length === right.length && new Set(left).size === left.length && left.every(capability => right.includes(capability));

export class ProviderAdapterRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();

  constructor(private readonly providers: ProviderRegistry, adapters: readonly ProviderAdapter[]) {
    for (const adapter of adapters) {
      const key = keyFor(adapter.providerId, adapter.role);
      if (this.#adapters.has(key)) throw new ProviderError("PROVIDER_ADAPTER_DUPLICATE", `Duplicate adapter for '${adapter.providerId}' and role '${adapter.role}'.`);
      const descriptor = providers.get(adapter.providerId, adapter.role);
      const expected = descriptor.capabilities.filter(capability => roleFor(capability) === adapter.role);
      if (adapter.backend !== descriptor.backend || !sameCapabilities(adapter.capabilities, expected)) {
        throw new ProviderError("PROVIDER_ADAPTER_MISMATCH", `Adapter capabilities do not match provider '${adapter.providerId}' role '${adapter.role}'.`);
      }
      this.#adapters.set(key, Object.freeze({ ...adapter, capabilities: Object.freeze([...adapter.capabilities]) }));
    }
  }

  get(providerId: string, role: ProviderRole): ProviderAdapter | undefined {
    return this.#adapters.get(keyFor(providerId, role));
  }
}

export interface WorkflowPolicy {
  authorize(request: ProviderInvocation): boolean | Promise<boolean>;
}

export class ProviderService {
  readonly #adapters: ProviderAdapterRegistry;

  constructor(private readonly providers: ProviderRegistry, adapters: readonly ProviderAdapter[], private readonly policy?: WorkflowPolicy) {
    this.#adapters = new ProviderAdapterRegistry(providers, adapters);
  }

  invoke<Capability extends ProviderCapability>(request: ProviderServiceInvocation<Capability>): Promise<ProviderCapabilityOutputMap[Capability]>;
  invoke(request: { providerId: string; capability: string; route?: string; input: JsonValue }): Promise<unknown>;
  async invoke(request: { providerId: string; capability: string; route?: string; input: unknown }): Promise<unknown> {
    this.providers.assertCapability(request.providerId, request.capability);
    const normalized: ProviderInvocation = { providerId: request.providerId, capability: request.capability, input: request.input as JsonValue, ...(request.route === undefined ? {} : { route: request.route }) };
    const adapter = this.#adapters.get(request.providerId, roleFor(request.capability));
    if (!adapter || !adapter.capabilities.includes(request.capability)) {
      throw new ProviderError("CAPABILITY_UNSUPPORTED", `Provider '${request.providerId}' has no installed adapter for ${request.capability}.`, { capability: request.capability });
    }
    if (adapter.routeRequired && request.route === undefined) {
      throw new ProviderError("PROVIDER_ROUTE_REQUIRED", `Provider '${request.providerId}' requires a configured route.`, { remediation: "Configure an identity provider route and relaunch." });
    }
    if (this.policy && !await this.policy.authorize(normalized)) {
      throw new ProviderError("WORKFLOW_POLICY_DENIED", `Workflow policy denied ${request.capability}.`, { capability: request.capability });
    }
    return adapter.invoke(normalized);
  }
}
