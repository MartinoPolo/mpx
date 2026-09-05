import { MpxError } from '@mpx/core';

export const ISSUE_CAPABILITIES = [
  'issue.list',
  'issue.view',
  'issue.create',
  'issue.edit',
  'issue.comment',
  'issue.label',
  'issue.move',
  'issue.finish',
] as const;
export const LOCAL_ISSUE_CAPABILITIES = [
  'issue.dependency.add',
  'issue.dependency.remove',
] as const;
export const REVIEW_CAPABILITIES = [
  'review.view',
  'review.create',
  'review.update',
  'review.comment',
  'review.ready',
  'review.merge',
] as const;
export const CI_CAPABILITIES = ['ci.status', 'ci.watch', 'ci.logs', 'ci.retry'] as const;

export type IssueCapability =
  (typeof ISSUE_CAPABILITIES)[number] | (typeof LOCAL_ISSUE_CAPABILITIES)[number];
export type ReviewCapability = (typeof REVIEW_CAPABILITIES)[number];
export type CiCapability = (typeof CI_CAPABILITIES)[number];
export type ProviderCapability = IssueCapability | ReviewCapability | CiCapability;
export type ProviderRole = 'repository' | 'issues';

export const capabilitiesForProviderRole = (
  capabilities: readonly ProviderCapability[],
  role: ProviderRole,
): readonly ProviderCapability[] =>
  capabilities.filter((capability) =>
    role === 'issues' ? capability.startsWith('issue.') : !capability.startsWith('issue.'),
  );

export type TrustedBackendId =
  'gh' | 'glab' | 'git-ssh' | 'kf' | 'filesystem' | 'none' | (string & {});
export type ProviderErrorCode =
  | 'PROVIDER_INVALID'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_ROUTE_REQUIRED'
  | 'PROVIDER_ADAPTER_DUPLICATE'
  | 'PROVIDER_ADAPTER_MISMATCH'
  | 'CAPABILITY_UNKNOWN'
  | 'CAPABILITY_UNSUPPORTED'
  | 'EXECUTABLE_MISSING'
  | 'AUTH_FAILURE'
  | 'COMMAND_FAILURE'
  | 'INVALID_RESPONSE'
  | 'MUTATION_OUTCOME_UNKNOWN'
  | 'WORKFLOW_POLICY_DENIED';

export class ProviderError extends MpxError {
  constructor(
    code: ProviderErrorCode,
    message: string,
    options: {
      capability?: string;
      retryable?: boolean;
      remediation?: string;
      details?: import('@mpx/core').JsonValue;
    } = {},
  ) {
    super({ code, message, ...options });
    this.name = 'ProviderError';
  }
}

export interface ProviderSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ProviderDescriptor {
  readonly id: string;
  readonly roles: readonly ProviderRole[];
  readonly capabilities: readonly ProviderCapability[];
  readonly backend: TrustedBackendId;
  readonly schema: ProviderSchema;
}

const ALL_CAPABILITIES = new Set<string>([
  ...ISSUE_CAPABILITIES,
  ...LOCAL_ISSUE_CAPABILITIES,
  ...REVIEW_CAPABILITIES,
  ...CI_CAPABILITIES,
]);
const EMPTY_SCHEMA: ProviderSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: false,
});
const REMOTE_SCHEMA: ProviderSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({ remote: Object.freeze({ type: 'string', minLength: 1 }) }),
  additionalProperties: false,
});
const KANBAN_SCHEMA: ProviderSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    boardId: Object.freeze({ type: 'string', minLength: 1 }),
    states: Object.freeze({ type: 'object' }),
  }),
  required: Object.freeze(['boardId']),
  additionalProperties: false,
});
const LOCAL_SCHEMA: ProviderSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    root: Object.freeze({ type: 'string', minLength: 1 }),
    views: Object.freeze({ type: 'object' }),
  }),
  required: Object.freeze(['root']),
  additionalProperties: false,
});

const freezeDescriptor = (descriptor: ProviderDescriptor): ProviderDescriptor =>
  Object.freeze({
    ...descriptor,
    roles: Object.freeze([...descriptor.roles]),
    capabilities: Object.freeze([...descriptor.capabilities]),
    schema: Object.freeze(descriptor.schema),
  });

const allIssue = [...ISSUE_CAPABILITIES];
const withoutMove = allIssue.filter((capability) => capability !== 'issue.move');
const localIssue = [...withoutMove, ...LOCAL_ISSUE_CAPABILITIES];
const hostedIssue = withoutMove;
const repoCaps = [...REVIEW_CAPABILITIES, ...CI_CAPABILITIES];
export const BUILTIN_PROVIDERS: readonly ProviderDescriptor[] = Object.freeze([
  freezeDescriptor({
    id: 'github',
    roles: ['repository', 'issues'],
    capabilities: [...hostedIssue, ...repoCaps],
    backend: 'gh',
    schema: REMOTE_SCHEMA,
  }),
  freezeDescriptor({
    id: 'gitlab',
    roles: ['repository', 'issues'],
    capabilities: [...hostedIssue, ...repoCaps],
    backend: 'glab',
    schema: REMOTE_SCHEMA,
  }),
  freezeDescriptor({
    id: 'gerrit',
    roles: ['repository'],
    capabilities: [...REVIEW_CAPABILITIES],
    backend: 'git-ssh',
    schema: REMOTE_SCHEMA,
  }),
  freezeDescriptor({
    id: 'generic',
    roles: ['repository'],
    capabilities: [],
    backend: 'none',
    schema: REMOTE_SCHEMA,
  }),
  freezeDescriptor({
    id: 'kanbanflow',
    roles: ['issues'],
    capabilities: allIssue,
    backend: 'kf',
    schema: KANBAN_SCHEMA,
  }),
  freezeDescriptor({
    id: 'local',
    roles: ['issues'],
    capabilities: localIssue,
    backend: 'filesystem',
    schema: LOCAL_SCHEMA,
  }),
  freezeDescriptor({
    id: 'none',
    roles: ['issues'],
    capabilities: [],
    backend: 'none',
    schema: EMPTY_SCHEMA,
  }),
]);

export class ProviderRegistry {
  readonly #providers: ReadonlyMap<string, ProviderDescriptor>;

  constructor() {
    this.#providers = new Map(BUILTIN_PROVIDERS.map((provider) => [provider.id, provider]));
    Object.freeze(this);
  }

  list(role?: ProviderRole): readonly ProviderDescriptor[] {
    return Object.freeze(
      [...this.#providers.values()]
        .filter((item) => role === undefined || item.roles.includes(role))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  get(id: string, role?: ProviderRole): ProviderDescriptor {
    const provider = this.#providers.get(id);
    if (!provider || (role !== undefined && !provider.roles.includes(role))) {
      throw new ProviderError(
        'PROVIDER_NOT_FOUND',
        `Provider '${id}' is not registered for ${role ?? 'any role'}.`,
      );
    }
    return provider;
  }

  schema(id: string, role?: ProviderRole): ProviderSchema {
    return this.get(id, role).schema;
  }

  assertCapability(id: string, capability: string): asserts capability is ProviderCapability {
    if (!ALL_CAPABILITIES.has(capability)) {
      throw new ProviderError('CAPABILITY_UNKNOWN', `Unknown capability: ${capability}`, {
        capability,
      });
    }
    if (!this.get(id).capabilities.includes(capability as ProviderCapability)) {
      throw new ProviderError(
        'CAPABILITY_UNSUPPORTED',
        `Provider '${id}' does not support ${capability}.`,
        { capability, remediation: 'Select a provider that declares this capability.' },
      );
    }
  }
}

export const providerRegistry: ProviderRegistry = new ProviderRegistry();
