import { randomUUID } from 'node:crypto';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import { ExecutionError } from './index.js';

const SHA = /^[a-f0-9]{64}$/u;
const FORBIDDEN_KEY =
  /^(?:authorization|oauth(?:Token)?|token|accessToken|refreshToken|apiKey|secret|password|PI_CODING_AGENT_DIR|accountRoot|accountPath|nativeRuntimeRoot|authJson)$/iu;
const FORBIDDEN_VALUE =
  /(?:PI_CODING_AGENT_DIR|auth\.json|Bearer\s+[A-Za-z0-9._~-]+|token-shaped-canary)/iu;

/** Complete model-triggerable Phase F1 surface. Child paths are attested as well as Pi-visible names. */
export const PHASE_F2_REMOTE_TOOL_PATHS = Object.freeze([
  'read',
  'write',
  'edit',
  'find',
  'grep',
  'ls',
  'bash',
  'shell/execute',
  'process',
  'process/start',
  'process/status',
  'process/logs',
  'process/stop',
  'git',
  'git/status',
  'git/diff',
  'git/log',
  'git/branch',
  'git/checkout',
  'git/commit',
  'git/worktree',
  'browser',
  'browser/navigate',
  'browser/snapshot',
  'browser/click',
  'browser/type',
  'browser/evaluate',
  'browser/screenshot',
  'mcp',
  'mcp/:server/:method',
  'web_search',
  'web_search/:provider/search',
  'fetch_content',
  'fetch_content/:provider/fetch',
  'get_search_content',
  'get_search_content/:response',
  'source_check',
  'source_check/web_search',
  'dev_server',
  'dev_server/start',
  'dev_server/status',
  'dev_server/logs',
  'dev_server/restart',
  'dev_server/stop',
  'mpx_model_search',
  'mpx_model_load',
  'Agent',
  'Agent/child',
  'Agent/nested',
  'Agent/group',
  'Agent/schedule',
  'get_subagent_result',
  'steer_subagent',
] as const);

export interface SandboxHandleBinding {
  readonly launchKey: string;
  readonly planKey: string;
  readonly runtimeToolInventorySha256: string;
  readonly capabilitySha256: string;
  readonly identity: { readonly name: string; readonly domain: 'personal' | 'work' };
  readonly executor: 'docker';
  readonly childKey?: string;
}
export interface RemoteToolEnvelope {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sequence: number;
  readonly launchKey: string;
  readonly planKey: string;
  readonly runtimeToolInventorySha256: string;
  readonly capabilitySha256: string;
  readonly childKey: string | null;
  readonly toolPath: string;
  readonly input: JsonValue;
  readonly inputSha256: string;
  readonly requestSha256: string;
}
export interface RemoteToolReply {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sequence: number;
  readonly requestSha256: string;
  readonly output: JsonValue;
}
export interface SandboxWorkerTransport {
  invoke(request: RemoteToolEnvelope, signal?: AbortSignal): Promise<RemoteToolReply>;
}
export interface RemoteToolSetAttestation {
  readonly toolPaths: readonly string[];
  readonly digest: string;
  readonly inventorySha256: string;
}

function fail(code: string, message: string): never {
  throw new ExecutionError(code, message);
}
function assertHash(value: string): void {
  if (!SHA.test(value)) {
    fail('REMOTE_BINDING_INVALID', 'Sandbox handle hashes are invalid.');
  }
}
function safeJson(value: unknown): JsonValue {
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && FORBIDDEN_VALUE.test(item)) {
      fail(
        'REMOTE_PRIVATE_DATA',
        'Private host account or OAuth data cannot enter a remote request.',
      );
    }
    if (!item || typeof item !== 'object') {
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_KEY.test(key)) {
        fail(
          'REMOTE_PRIVATE_DATA',
          'Private host account or OAuth fields cannot enter a remote request.',
        );
      }
      visit(child);
    }
  };
  visit(value);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return fail('REMOTE_REQUEST_INVALID', 'Remote input must be JSON serializable.');
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
    fail('REMOTE_REQUEST_INVALID', 'Remote input exceeds bounds.');
  }
  return JSON.parse(encoded) as JsonValue;
}
function exactPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(paths)].sort());
}
export function attestRemoteToolSet(
  attestation: RemoteToolSetAttestation,
  expected: readonly string[],
  inventorySha256?: string,
): boolean {
  const paths = exactPaths(expected);
  return (
    JSON.stringify(attestation.toolPaths) === JSON.stringify(paths) &&
    attestation.digest === sha256Canonical(paths as unknown as JsonValue) &&
    (inventorySha256 === undefined || attestation.inventorySha256 === inventorySha256)
  );
}

export class ProductionRemoteToolClient {
  readonly #seen = new Set<string>();
  #sequence = 0;
  constructor(
    readonly descriptor: Readonly<SandboxHandleBinding>,
    readonly transport: SandboxWorkerTransport,
    readonly isCurrent: () => boolean = () => true,
  ) {}
  attestation(): RemoteToolSetAttestation {
    const toolPaths = exactPaths(PHASE_F2_REMOTE_TOOL_PATHS);
    return Object.freeze({
      toolPaths,
      digest: sha256Canonical(toolPaths as unknown as JsonValue),
      inventorySha256: this.descriptor.runtimeToolInventorySha256,
    });
  }
  async execute(
    toolPath: string,
    input: unknown,
    options: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<JsonValue> {
    if (!this.isCurrent()) {
      fail('REMOTE_HANDLE_STALE', 'Sandbox handle was replaced for this launch.');
    }
    if (!(PHASE_F2_REMOTE_TOOL_PATHS as readonly string[]).includes(toolPath)) {
      fail('REMOTE_TOOL_DENIED', 'Tool path is outside the attested F1 inventory.');
    }
    const requestId = options.requestId ?? randomUUID();
    if (this.#seen.has(requestId)) {
      fail('REMOTE_REPLAY', 'Remote request was already used.');
    }
    this.#seen.add(requestId);
    const payload = safeJson(input);
    const inputSha256 = sha256Canonical(payload);
    const sequence = ++this.#sequence;
    const tuple = {
      schemaVersion: 1 as const,
      requestId,
      sequence,
      launchKey: this.descriptor.launchKey,
      planKey: this.descriptor.planKey,
      runtimeToolInventorySha256: this.descriptor.runtimeToolInventorySha256,
      capabilitySha256: this.descriptor.capabilitySha256,
      childKey: this.descriptor.childKey ?? null,
      toolPath,
      input: payload,
      inputSha256,
    };
    const request: RemoteToolEnvelope = Object.freeze({
      ...tuple,
      requestSha256: sha256Canonical(tuple as unknown as JsonValue),
    });
    if (options.signal?.aborted) {
      fail('REMOTE_CANCELLED', 'Remote request was cancelled.');
    }
    const result = await this.transport.invoke(request, options.signal);
    if (options.signal?.aborted) {
      fail('REMOTE_CANCELLED', 'Remote request was cancelled.');
    }
    if (
      result.schemaVersion !== 1 ||
      result.requestId !== requestId ||
      result.sequence !== sequence ||
      result.requestSha256 !== request.requestSha256
    ) {
      fail('REMOTE_STALE_RESULT', 'Remote result does not match its request.');
    }
    return safeJson(result.output);
  }
}
export interface SandboxHandle {
  readonly descriptor: Readonly<SandboxHandleBinding>;
  readonly client: ProductionRemoteToolClient;
}
export function createSandboxHandle(
  binding: SandboxHandleBinding,
  transport: SandboxWorkerTransport,
  isCurrent?: () => boolean,
): SandboxHandle {
  for (const hash of [
    binding.launchKey,
    binding.planKey,
    binding.runtimeToolInventorySha256,
    binding.capabilitySha256,
  ]) {
    assertHash(hash);
  }
  if (binding.executor !== 'docker') {
    fail('REMOTE_BINDING_INVALID', 'Remote handles are Docker-only.');
  }
  const descriptor = Object.freeze({
    ...binding,
    identity: Object.freeze({ ...binding.identity }),
  });
  return Object.freeze({
    descriptor,
    client: new ProductionRemoteToolClient(descriptor, transport, isCurrent),
  });
}

export class ProductionRemoteExecutorRegistry {
  readonly #bindings = new Map<string, { generation: number; handle: SandboxHandle }>();
  bind(handle: SandboxHandle): void {
    const current = this.#bindings.get(handle.descriptor.launchKey);
    const generation = (current?.generation ?? 0) + 1;
    const rebound = createSandboxHandle(
      handle.descriptor,
      handle.client.transport,
      () => this.#bindings.get(handle.descriptor.launchKey)?.generation === generation,
    );
    this.#bindings.set(handle.descriptor.launchKey, { generation, handle: rebound });
  }
  forLaunch(
    launchKey: string,
    identity: SandboxHandleBinding['identity'],
  ): ProductionRemoteToolClient {
    const bound = this.#bindings.get(launchKey);
    if (!bound) {
      return fail('REMOTE_EXECUTOR_UNAVAILABLE', 'No sandbox handle is bound to this launch.');
    }
    if (
      bound.handle.descriptor.identity.name !== identity.name ||
      bound.handle.descriptor.identity.domain !== identity.domain
    ) {
      fail(
        'REMOTE_IDENTITY_DENIED',
        'IDENTITY mismatch: sandbox handle belongs to another identity.',
      );
    }
    return bound.handle.client;
  }
}

/** In-memory protocol worker for integration tests; it has deliberately no host fallback. */
export class FakeSandboxWorker implements SandboxWorkerTransport {
  readonly serializedRequests: string[] = [];
  readonly hostFallbackCalls = 0;
  constructor(
    readonly handlers: Readonly<Record<string, (input: JsonValue) => Promise<JsonValue>>>,
  ) {}
  async invoke(request: RemoteToolEnvelope, signal?: AbortSignal): Promise<RemoteToolReply> {
    this.serializedRequests.push(JSON.stringify(request));
    const handler = this.handlers[request.toolPath];
    if (!handler) {
      fail('REMOTE_TOOL_UNAVAILABLE', 'Fake sandbox worker has no handler for this path.');
    }
    if (signal?.aborted) {
      fail('REMOTE_CANCELLED', 'Remote request was cancelled.');
    }
    const cancelled = new Promise<never>((_, reject) =>
      signal?.addEventListener(
        'abort',
        () => reject(new ExecutionError('REMOTE_CANCELLED', 'Remote request was cancelled.')),
        { once: true },
      ),
    );
    const output = await (signal
      ? Promise.race([handler(request.input), cancelled])
      : handler(request.input));
    return Object.freeze({
      schemaVersion: 1,
      requestId: request.requestId,
      sequence: request.sequence,
      requestSha256: request.requestSha256,
      output,
    });
  }
  get scan() {
    const text = this.serializedRequests.join('\n');
    return Object.freeze({
      oauthTokenPresent: /oauth|Bearer\s/iu.test(text),
      piCodingAgentDirPresent: /PI_CODING_AGENT_DIR/u.test(text),
      authJsonPresent: /auth\.json/iu.test(text),
      accountRootPresent: /accountRoot|nativeRuntimeRoot/iu.test(text),
      canaryPresent: /token-shaped-canary/u.test(text),
    });
  }
}
