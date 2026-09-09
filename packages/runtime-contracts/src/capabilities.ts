import { createHash } from 'node:crypto';
import { parseSkillSelection } from './skill-selection.js';
import type { ResolvedSkillSelection } from './skill-selection.js';

export const RUNTIME_CAPABILITY_MANIFEST_SCHEMA_VERSION = 2 as const;
export const TOOL_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const TOOL_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const CHILD_LAUNCH_AUTHORITY_SCHEMA_VERSION = 1 as const;

export type CapabilityExecutor = 'docker' | 'host';
export type CapabilityRuntime = 'claude' | 'pi';
export type CacheMode = 'disabled' | 'read-only' | 'read-write';
export type JsonData =
  null | boolean | number | string | readonly JsonData[] | { readonly [key: string]: JsonData };
export interface CapabilityIdentity {
  readonly name: string;
  readonly domain: string;
  readonly nativeRuntimeRootDigest: string;
}
export interface CapabilityBinding {
  readonly projectId: string | null;
  readonly repositoryId: string;
  readonly selection: ResolvedSkillSelection;
}
export interface ToolAuthority {
  readonly schemaVersion: typeof TOOL_AUTHORITY_SCHEMA_VERSION;
  readonly name: string;
  readonly executors: readonly CapabilityExecutor[];
  readonly routes: readonly string[];
  readonly network: {
    readonly mode: 'deny-all' | 'allow-list';
    readonly destinations: readonly string[];
  };
  readonly paidCredits: { readonly allowed: boolean; readonly maxCredits: number };
  readonly input: { readonly maxBytes: number };
  readonly output: { readonly maxBytes: number };
  readonly timeout: { readonly maxMs: number };
  readonly cache: { readonly mode: CacheMode; readonly maxBytes: number };
}
export interface RuntimeCapabilityManifest {
  readonly schemaVersion: typeof RUNTIME_CAPABILITY_MANIFEST_SCHEMA_VERSION;
  readonly manifestKey: string;
  readonly runtime: CapabilityRuntime;
  readonly launchKey: string;
  readonly identity: CapabilityIdentity;
  readonly binding: CapabilityBinding;
  readonly executor: CapabilityExecutor;
  readonly tools: readonly ToolAuthority[];
  readonly routes: readonly string[];
  readonly resources: readonly string[];
  readonly mounts: readonly string[];
  readonly destinations: readonly string[];
  readonly skills: readonly string[];
  readonly models: readonly string[];
  readonly nesting: { readonly depth: number; readonly maxDepth: number };
}
export type RuntimeCapabilityManifestInput =
  | Omit<RuntimeCapabilityManifest, 'schemaVersion' | 'manifestKey'>
  | Omit<RuntimeCapabilityManifest, 'manifestKey'>;

export class CapabilityContractError extends Error {
  readonly name = 'CapabilityContractError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
function fail(code: string, message: string): never {
  throw new CapabilityContractError(code, message);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
const SHA = /^[a-f0-9]{64}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
function label(value: unknown, field: string): string {
  if (typeof value !== 'string' || !LABEL.test(value)) {
    fail('INVALID_CAPABILITY', `${field} is not a bounded label`);
  }
  return value;
}
function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) {
    fail('INVALID_CAPABILITY', `${field} must be a SHA-256 digest`);
  }
  return value;
}
function integer(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail('INVALID_CAPABILITY', `${field} is outside its bound`);
  }
  return value as number;
}
function executor(value: unknown): CapabilityExecutor {
  if (value !== 'docker' && value !== 'host') {
    fail('INVALID_CAPABILITY', 'executor is invalid');
  }
  return value;
}
function runtime(value: unknown): CapabilityRuntime {
  if (value !== 'claude' && value !== 'pi') {
    fail('INVALID_CAPABILITY', 'runtime is invalid');
  }
  return value;
}
function labels(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 256) {
    fail('INVALID_CAPABILITY', `${field} must be a bounded array`);
  }
  return Object.freeze([...new Set(values.map((value) => label(value, field)))].sort());
}
function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}
function exactKeys(value: object, expected: readonly string[], field: string): void {
  const keys = Object.keys(value);
  const extra = keys.find((key) => !expected.includes(key));
  if (extra) {
    fail('INVALID_CAPABILITY', `${field} contains unknown field '${extra}'`);
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing) {
    fail('INVALID_CAPABILITY', `${field} is missing '${missing}'`);
  }
}
function identity(value: CapabilityIdentity): CapabilityIdentity {
  return Object.freeze({
    name: label(value?.name, 'identity.name'),
    domain: label(value?.domain, 'identity.domain'),
    nativeRuntimeRootDigest: digest(
      value?.nativeRuntimeRootDigest,
      'identity.nativeRuntimeRootDigest',
    ),
  });
}
function binding(value: CapabilityBinding): CapabilityBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CAPABILITY', 'binding must be an object');
  }
  exactKeys(value, ['projectId', 'repositoryId', 'selection'], 'binding');
  if (
    value.projectId !== null &&
    (typeof value.projectId !== 'string' || !LABEL.test(value.projectId))
  ) {
    fail('INVALID_CAPABILITY', 'binding.projectId is invalid');
  }
  return Object.freeze({
    projectId: value.projectId,
    repositoryId: label(value.repositoryId, 'binding.repositoryId'),
    selection: parseSkillSelection(value.selection, (_code, message) =>
      fail('INVALID_CAPABILITY', message),
    ),
  });
}
function toolAuthority(value: Omit<ToolAuthority, 'schemaVersion'> | ToolAuthority): ToolAuthority {
  const mode = value.network?.mode;
  if (mode !== 'deny-all' && mode !== 'allow-list') {
    fail('INVALID_CAPABILITY', 'tool network mode is invalid');
  }
  const cacheMode = value.cache?.mode;
  if (!(['disabled', 'read-only', 'read-write'] as const).includes(cacheMode)) {
    fail('INVALID_CAPABILITY', 'tool cache mode is invalid');
  }
  if (typeof value.paidCredits?.allowed !== 'boolean') {
    fail('INVALID_CAPABILITY', 'tool paid credit policy is invalid');
  }
  const destinations = labels(value.network.destinations, 'tool.network.destinations');
  if (mode === 'deny-all' && destinations.length) {
    fail('INVALID_CAPABILITY', 'deny-all tool cannot declare destinations');
  }
  return Object.freeze({
    schemaVersion: 1,
    name: label(value.name, 'tool.name'),
    executors: Object.freeze([...new Set(value.executors.map(executor))].sort()),
    routes: labels(value.routes, 'tool.routes'),
    network: Object.freeze({ mode, destinations }),
    paidCredits: Object.freeze({
      allowed: value.paidCredits.allowed,
      maxCredits: integer(value.paidCredits.maxCredits, 'tool.paidCredits.maxCredits', 1_000_000),
    }),
    input: Object.freeze({
      maxBytes: integer(value.input?.maxBytes, 'tool.input.maxBytes', 16 * 1024 * 1024),
    }),
    output: Object.freeze({
      maxBytes: integer(value.output?.maxBytes, 'tool.output.maxBytes', 16 * 1024 * 1024),
    }),
    timeout: Object.freeze({
      maxMs: integer(value.timeout?.maxMs, 'tool.timeout.maxMs', 3_600_000),
    }),
    cache: Object.freeze({
      mode: cacheMode,
      maxBytes: integer(value.cache?.maxBytes, 'tool.cache.maxBytes', 64 * 1024 * 1024),
    }),
  });
}
export function createRuntimeCapabilityManifest(
  input: RuntimeCapabilityManifestInput,
): RuntimeCapabilityManifest {
  if (
    'schemaVersion' in input &&
    input.schemaVersion !== RUNTIME_CAPABILITY_MANIFEST_SCHEMA_VERSION
  ) {
    fail('UNKNOWN_SCHEMA_VERSION', 'runtime capability manifest version is unsupported');
  }
  if (!Array.isArray(input.tools)) {
    fail('INVALID_CAPABILITY', 'tools must be a bounded array');
  }
  const depth = integer(input.nesting?.depth, 'nesting.depth', 32),
    maxDepth = integer(input.nesting?.maxDepth, 'nesting.maxDepth', 32);
  if (depth > maxDepth) {
    fail('INVALID_CAPABILITY', 'nesting depth exceeds maximum');
  }
  const tools = Object.freeze(
    input.tools.map(toolAuthority).sort((a, b) => a.name.localeCompare(b.name)),
  );
  if (new Set(tools.map((item) => item.name)).size !== tools.length) {
    fail('INVALID_CAPABILITY', 'tool names must be unique');
  }
  const tuple = Object.freeze({
    schemaVersion: RUNTIME_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    runtime: runtime(input.runtime),
    launchKey: digest(input.launchKey, 'launchKey'),
    identity: identity(input.identity),
    binding: binding(input.binding),
    executor: executor(input.executor),
    tools,
    routes: labels(input.routes, 'routes'),
    resources: labels(input.resources, 'resources'),
    mounts: labels(input.mounts, 'mounts'),
    destinations: labels(input.destinations, 'destinations'),
    skills: labels(input.skills, 'skills'),
    models: labels(input.models, 'models'),
    nesting: Object.freeze({ depth, maxDepth }),
  });
  for (const item of tools) {
    if (
      item.routes.some((route) => !tuple.routes.includes(route)) ||
      item.network.destinations.some((destination) => !tuple.destinations.includes(destination)) ||
      !item.executors.includes(tuple.executor)
    ) {
      fail('INVALID_CAPABILITY', `tool '${item.name}' exceeds manifest authority`);
    }
  }
  return Object.freeze({ ...tuple, manifestKey: hash(tuple) });
}
export function parseRuntimeCapabilityManifest(value: unknown): RuntimeCapabilityManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CAPABILITY', 'manifest must be an object');
  }
  exactKeys(
    value,
    [
      'schemaVersion',
      'manifestKey',
      'runtime',
      'launchKey',
      'identity',
      'binding',
      'executor',
      'tools',
      'routes',
      'resources',
      'mounts',
      'destinations',
      'skills',
      'models',
      'nesting',
    ],
    'manifest',
  );
  const item = value as RuntimeCapabilityManifest;
  if (item.schemaVersion !== RUNTIME_CAPABILITY_MANIFEST_SCHEMA_VERSION) {
    fail('UNKNOWN_SCHEMA_VERSION', 'runtime capability manifest version is unsupported');
  }
  const parsed = createRuntimeCapabilityManifest(item);
  if (item.manifestKey !== parsed.manifestKey) {
    fail('CAPABILITY_KEY_MISMATCH', 'manifest key does not match its contents');
  }
  return parsed;
}
export interface RuntimeCapabilityBinding {
  readonly manifestKey: string;
  readonly launchKey: string;
  readonly runtime: CapabilityRuntime;
  readonly identity: CapabilityIdentity;
  readonly binding: CapabilityBinding;
  readonly executor: CapabilityExecutor;
}
export function validateRuntimeCapabilityBinding(
  manifestInput: RuntimeCapabilityManifest,
  expected: RuntimeCapabilityBinding,
): RuntimeCapabilityManifest {
  const manifest = parseRuntimeCapabilityManifest(manifestInput);
  const actual = {
    manifestKey: manifest.manifestKey,
    launchKey: manifest.launchKey,
    runtime: manifest.runtime,
    identity: manifest.identity,
    binding: manifest.binding,
    executor: manifest.executor,
  };
  if (!same(actual, expected)) {
    fail('CAPABILITY_STALE', 'runtime capability binding is stale or belongs to another launch');
  }
  return manifest;
}

export interface ToolRequestEnvelope {
  readonly schemaVersion: 1;
  readonly requestKey: string;
  readonly manifestKey: string;
  readonly launchKey: string;
  readonly tool: string;
  readonly executor: CapabilityExecutor;
  readonly route: string | null;
  readonly destination: string | null;
  readonly paidCredits: number;
  readonly timeoutMs: number;
  readonly cacheMode: CacheMode;
  readonly input: JsonData;
}
export type ToolRequestInput = Omit<ToolRequestEnvelope, 'schemaVersion' | 'requestKey'>;
function jsonBytes(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail('INVALID_CAPABILITY', 'envelope payload must be JSON serializable');
  }
  if (encoded === undefined) {
    fail('INVALID_CAPABILITY', 'envelope payload must be JSON serializable');
  }
  return Buffer.byteLength(encoded);
}
export function createToolRequestEnvelope(input: ToolRequestInput): ToolRequestEnvelope {
  const cacheMode = input.cacheMode;
  if (!(['disabled', 'read-only', 'read-write'] as const).includes(cacheMode)) {
    fail('INVALID_CAPABILITY', 'cache mode is invalid');
  }
  if (jsonBytes(input.input) > 16 * 1024 * 1024) {
    fail('ENVELOPE_LIMIT', 'request input exceeds the global envelope bound');
  }
  const tuple = {
    schemaVersion: 1 as const,
    manifestKey: digest(input.manifestKey, 'manifestKey'),
    launchKey: digest(input.launchKey, 'launchKey'),
    tool: label(input.tool, 'tool'),
    executor: executor(input.executor),
    route: input.route === null ? null : label(input.route, 'route'),
    destination: input.destination === null ? null : label(input.destination, 'destination'),
    paidCredits: integer(input.paidCredits, 'paidCredits', 1_000_000),
    timeoutMs: integer(input.timeoutMs, 'timeoutMs', 3_600_000),
    cacheMode,
    input: input.input,
  };
  return Object.freeze({ ...tuple, requestKey: hash(tuple) });
}
export interface ToolResultEnvelope {
  readonly schemaVersion: 1;
  readonly requestKey: string;
  readonly output: JsonData;
}
export function createToolResultEnvelope(input: {
  requestKey: string;
  output: JsonData;
  maxOutputBytes: number;
}): ToolResultEnvelope {
  digest(input.requestKey, 'requestKey');
  if (jsonBytes(input.output) > integer(input.maxOutputBytes, 'maxOutputBytes', 16 * 1024 * 1024)) {
    fail('ENVELOPE_LIMIT', 'tool output exceeds its bound');
  }
  return Object.freeze({ schemaVersion: 1, requestKey: input.requestKey, output: input.output });
}
export interface ToolErrorEnvelope {
  readonly schemaVersion: 1;
  readonly requestKey: string;
  readonly code: string;
  readonly message: string;
}
export function createToolErrorEnvelope(input: {
  requestKey: string;
  code: string;
  message: string;
}): ToolErrorEnvelope {
  digest(input.requestKey, 'requestKey');
  const code = label(input.code, 'error.code');
  if (typeof input.message !== 'string' || Buffer.byteLength(input.message) > 256) {
    fail('ENVELOPE_LIMIT', 'tool error message exceeds its bound');
  }
  return Object.freeze({
    schemaVersion: 1,
    requestKey: input.requestKey,
    code,
    message: input.message,
  });
}
function cacheRank(mode: CacheMode): number {
  return { disabled: 0, 'read-only': 1, 'read-write': 2 }[mode];
}
export function validateToolCall(
  manifestInput: RuntimeCapabilityManifest,
  request: ToolRequestEnvelope,
): ToolRequestEnvelope {
  const manifest = parseRuntimeCapabilityManifest(manifestInput);
  const parsed = createToolRequestEnvelope(request);
  if (parsed.requestKey !== request.requestKey) {
    fail('CAPABILITY_KEY_MISMATCH', 'request key does not match its contents');
  }
  if (parsed.manifestKey !== manifest.manifestKey || parsed.launchKey !== manifest.launchKey) {
    fail('CAPABILITY_STALE', 'tool request belongs to another launch');
  }
  const authority = manifest.tools.find((item) => item.name === parsed.tool);
  if (!authority) {
    fail('TOOL_AUTHORITY_DENIED', 'tool is not authorized');
  }
  if (
    !authority.executors.includes(parsed.executor) ||
    parsed.executor !== manifest.executor ||
    (parsed.route !== null && !authority.routes.includes(parsed.route)) ||
    (parsed.destination !== null &&
      (authority.network.mode !== 'allow-list' ||
        !authority.network.destinations.includes(parsed.destination))) ||
    (!authority.paidCredits.allowed && parsed.paidCredits > 0) ||
    parsed.paidCredits > authority.paidCredits.maxCredits ||
    parsed.timeoutMs > authority.timeout.maxMs ||
    cacheRank(parsed.cacheMode) > cacheRank(authority.cache.mode)
  ) {
    fail('TOOL_AUTHORITY_DENIED', 'tool call exceeds its authority');
  }
  if (jsonBytes(parsed.input) > authority.input.maxBytes) {
    fail('ENVELOPE_LIMIT', 'tool input exceeds its authority bound');
  }
  return parsed;
}
export function validateToolResult(
  manifestInput: RuntimeCapabilityManifest,
  request: ToolRequestEnvelope,
  result: ToolResultEnvelope,
): ToolResultEnvelope {
  const manifest = parseRuntimeCapabilityManifest(manifestInput);
  const admitted = validateToolCall(manifest, request);
  if (result.schemaVersion !== 1 || result.requestKey !== admitted.requestKey) {
    fail('CAPABILITY_STALE', 'tool result belongs to another request');
  }
  const authority = manifest.tools.find((item) => item.name === admitted.tool)!;
  return createToolResultEnvelope({
    requestKey: result.requestKey,
    output: result.output,
    maxOutputBytes: authority.output.maxBytes,
  });
}

export interface ChildLaunchRequest {
  readonly schemaVersion: 1;
  readonly parentManifestKey: string;
  readonly parentLaunchKey: string;
  readonly runtime: CapabilityRuntime;
  readonly identity: CapabilityIdentity;
  readonly binding: CapabilityBinding;
  readonly executor: CapabilityExecutor;
  readonly tools: readonly string[];
  readonly routes: readonly string[];
  readonly resources: readonly string[];
  readonly mounts: readonly string[];
  readonly destinations: readonly string[];
  readonly skills: readonly string[];
  readonly models: readonly string[];
  readonly nesting: { readonly depth: number; readonly maxDepth: number };
}
export interface ChildLaunchAuthority extends ChildLaunchRequest {
  readonly childKey: string;
}
export function deriveChildAuthority(
  parentInput: RuntimeCapabilityManifest,
  request: ChildLaunchRequest,
): ChildLaunchAuthority {
  const parent = parseRuntimeCapabilityManifest(parentInput);
  if (request.schemaVersion !== 1) {
    fail('UNKNOWN_SCHEMA_VERSION', 'child authority request version is unsupported');
  }
  if (
    request.parentManifestKey !== parent.manifestKey ||
    request.parentLaunchKey !== parent.launchKey
  ) {
    fail('PARENT_AUTHORITY_STALE', 'parent authority is stale');
  }
  const requestedIdentity = identity(request.identity),
    requestedBinding = binding(request.binding),
    requestedRuntime = runtime(request.runtime),
    requestedExecutor = executor(request.executor);
  if (
    requestedRuntime !== parent.runtime ||
    requestedExecutor !== parent.executor ||
    !same(requestedIdentity, parent.identity) ||
    !same(requestedBinding, parent.binding)
  ) {
    fail(
      'CHILD_BINDING_MISMATCH',
      'child must preserve runtime, identity, root, executor, and binding',
    );
  }
  const axes = {
    tools: labels(request.tools, 'tools'),
    routes: labels(request.routes, 'routes'),
    resources: labels(request.resources, 'resources'),
    mounts: labels(request.mounts, 'mounts'),
    destinations: labels(request.destinations, 'destinations'),
    skills: labels(request.skills, 'skills'),
    models: labels(request.models, 'models'),
  };
  const parentAxes = {
    tools: parent.tools.map((item) => item.name),
    routes: parent.routes,
    resources: parent.resources,
    mounts: parent.mounts,
    destinations: parent.destinations,
    skills: parent.skills,
    models: parent.models,
  };
  for (const axis of Object.keys(axes) as Array<keyof typeof axes>) {
    if (axes[axis].some((value) => !parentAxes[axis].includes(value))) {
      fail('CHILD_AUTHORITY_WIDENING', `child ${axis} authority exceeds parent`);
    }
  }
  const depth = integer(request.nesting?.depth, 'nesting.depth', 32),
    maxDepth = integer(request.nesting?.maxDepth, 'nesting.maxDepth', 32);
  if (
    depth !== parent.nesting.depth + 1 ||
    depth > parent.nesting.maxDepth ||
    maxDepth > parent.nesting.maxDepth ||
    maxDepth < depth
  ) {
    fail('CHILD_AUTHORITY_WIDENING', 'child nesting authority exceeds parent');
  }
  const tuple = {
    schemaVersion: 1 as const,
    parentManifestKey: parent.manifestKey,
    parentLaunchKey: parent.launchKey,
    runtime: requestedRuntime,
    identity: requestedIdentity,
    binding: requestedBinding,
    executor: requestedExecutor,
    ...axes,
    nesting: Object.freeze({ depth, maxDepth }),
  };
  return Object.freeze({ ...tuple, childKey: hash(tuple) });
}
