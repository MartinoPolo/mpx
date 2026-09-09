import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Canonical } from '@mpx/core';
import { parseLaunchDescriptor } from '@mpx/launch';
import type { LaunchDescriptor } from '@mpx/launch';
import {
  parseRuntimeSkillArtifactReference,
  validateRuntimeCapabilityBinding,
  type RuntimeCapabilityManifest,
  type RuntimeSkillArtifactReference,
} from '@mpx/runtime-contracts';
import {
  ExecutionError,
  fail,
  type ProcessRequest,
  type ProcessResult,
} from './execution-process.js';

export {
  ExecutionError,
  invokeBoundedProcess,
  type BoundedProcessRunner,
  type ProcessRequest,
  type ProcessResult,
} from './execution-process.js';

export interface ExecutorAdapter {
  readonly name: 'docker' | 'host';
  assertReady(): Promise<void>;
  execute(request: ProcessRequest): Promise<ProcessResult>;
}
export class ExecutorRegistry {
  readonly #adapters = new Map<string, ExecutorAdapter>();
  register(adapter: ExecutorAdapter): void {
    this.#adapters.set(adapter.name, adapter);
  }
  get(name: string): ExecutorAdapter {
    return (
      this.#adapters.get(name) ??
      fail('EXECUTOR_UNAVAILABLE', `Executor '${name}' is unavailable.`, { executor: name })
    );
  }
}
export interface RuntimeLaunchService {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly ports: readonly number[];
  readonly assignment: { readonly worktreeRoot: string; readonly ports: readonly number[] };
  readonly executor: 'docker' | 'host';
  readonly environment?: Readonly<Record<string, string>>;
}
export interface RuntimeLaunchBinding {
  readonly launchKey: string;
  readonly runtime: 'claude' | 'pi';
  readonly identity: LaunchDescriptor['identity'];
  readonly worktreeRoot: string;
  readonly assignedPorts: readonly number[];
  readonly services?: Readonly<Record<string, RuntimeLaunchService>>;
  readonly executor: 'docker' | 'host';
}
export interface RuntimePreparation {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly shutdown?: () => Promise<void>;
}
export interface RuntimeAdapter {
  readonly runtime: 'claude' | 'pi';
  readonly modelTriggerableTools?: readonly string[];
  prepare(input: {
    descriptor: LaunchDescriptor;
    routes: Readonly<Record<string, string>>;
    capability?: RuntimeCapabilityManifest;
    statusEnvelope?: unknown;
    launchBinding?: RuntimeLaunchBinding;
  }): Promise<RuntimePreparation>;
}
export class RuntimeAdapterRegistry {
  readonly #adapters = new Map<string, RuntimeAdapter>();
  register(adapter: RuntimeAdapter): void {
    this.#adapters.set(adapter.runtime, adapter);
  }
  get(runtime: string): RuntimeAdapter {
    return (
      this.#adapters.get(runtime) ??
      fail('RUNTIME_ADAPTER_UNAVAILABLE', `Runtime adapter '${runtime}' is unavailable.`, {
        runtime,
      })
    );
  }
}

export interface DirectTty {
  readonly direct: boolean;
  confirm(message: string): Promise<boolean>;
}
export interface HostApprovalRequest {
  readonly requestDigest: string;
  readonly nonce: string;
  readonly reason: string;
}
export interface HostExecutionApproval {
  readonly requestDigest: string;
  readonly nonce: string;
}
export function sanitizeHostReason(value: string): string {
  const result = value
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .replace(/[A-Za-z]:[\\/][^\s,;]+/gu, '[path]')
    .replace(/(^|[\s(])\/[^\s,;)]+/gu, '$1[path]')
    .replace(/(token|secret|password|key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, 256);
  return (
    result || fail('HOST_REASON_REQUIRED', 'Host execution requires a nonempty sanitized reason.')
  );
}
export class HostApprovalStore {
  readonly #approved = new Set<string>();
  async approve(
    request: HostApprovalRequest,
    tty: DirectTty | undefined,
    approveHost = false,
  ): Promise<HostExecutionApproval> {
    if (!approveHost && !tty?.direct) {
      fail('HOST_TTY_REQUIRED', 'Host approval requires a direct TTY.');
    }
    const reason = sanitizeHostReason(request.reason);
    if (!request.nonce.trim() || !request.requestDigest.match(/^[a-f0-9]{64}$/u)) {
      fail('HOST_APPROVAL_INVALID', 'Host approval request is invalid.');
    }
    if (
      !approveHost &&
      !(await tty?.confirm(
        `Approve host execution ${request.requestDigest.slice(0, 12)} — ${reason}`,
      ))
    ) {
      fail('HOST_APPROVAL_DENIED', 'Host execution was not approved.');
    }
    const key = `${request.requestDigest}:${request.nonce}`;
    this.#approved.add(key);
    return Object.freeze({ requestDigest: request.requestDigest, nonce: request.nonce });
  }
  consume(expected: HostApprovalRequest, approval: HostExecutionApproval | undefined): void {
    const key = approval && `${approval.requestDigest}:${approval.nonce}`;
    if (
      !key ||
      approval.requestDigest !== expected.requestDigest ||
      approval.nonce !== expected.nonce ||
      !this.#approved.delete(key)
    ) {
      fail(
        'HOST_APPROVAL_MISMATCH',
        'Host approval is absent, stale, consumed, or bound to another request.',
      );
    }
  }
}

export interface PrivateRuntimeLaunch {
  readonly launchKey: string;
  readonly runtime: 'claude' | 'pi';
  readonly identity: LaunchDescriptor['identity'];
  readonly nativeRuntimeRoot: string;
}
export interface ExecuteInput {
  readonly descriptor: LaunchDescriptor;
  readonly artifact: RuntimeSkillArtifactReference;
  readonly capability?: RuntimeCapabilityManifest;
  readonly runtimeStatusEnvelope?: unknown;
  readonly runtimeLaunchBinding?: RuntimeLaunchBinding;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly privateLaunch?: PrivateRuntimeLaunch;
  readonly expectedLaunchKey?: string;
  readonly hostApproval?: HostExecutionApproval;
  readonly tty?: DirectTty;
  readonly approveHost?: boolean;
  readonly approvalNonce?: string;
}
export interface RouteMaterializer {
  materialize(
    descriptor: LaunchDescriptor,
    projectRoot?: string,
  ): Promise<Readonly<Record<string, string>>>;
}
export interface LaunchAuditStartRecord {
  readonly schemaVersion: 1;
  readonly phase: 'start';
  readonly launchKey: string;
  readonly runtime: 'claude' | 'pi';
  readonly executor: 'docker' | 'host';
  readonly identity: string;
  readonly identityDomain: string;
  readonly mode: string;
  readonly selectionSource: LaunchDescriptor['selection']['source'];
  readonly projectId: string | null;
  readonly repositoryId: string;
  readonly manifestKey: string;
  readonly artifactKey: string;
  readonly fileMapHash: string;
  readonly elevated: boolean;
  readonly reason: string | null;
}
export interface LaunchAuditTerminalRecord {
  readonly schemaVersion: 1;
  readonly phase: 'terminal';
  readonly launchKey: string;
  readonly outcome: 'result' | 'failure';
  readonly exitCode: number | null;
  readonly truncated: boolean | null;
  readonly errorCode: string | null;
}
export type LaunchAuditRecord = Readonly<LaunchAuditStartRecord | LaunchAuditTerminalRecord>;
export interface LaunchAuditStore {
  start(record: LaunchAuditStartRecord): Promise<string>;
  terminal(attemptId: string, record: LaunchAuditTerminalRecord): Promise<void>;
}
function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export class FileLaunchAuditStore implements LaunchAuditStore {
  constructor(readonly root: string) {}
  async start(record: LaunchAuditStartRecord): Promise<string> {
    const attemptId = randomUUID();
    await this.#write(attemptId, 'start', record);
    return attemptId;
  }
  async terminal(attemptId: string, record: LaunchAuditTerminalRecord): Promise<void> {
    if (!/^[0-9a-f-]{36}$/u.test(attemptId)) {
      throw new Error('Invalid audit attempt identifier.');
    }
    await this.#write(attemptId, 'terminal', record);
  }
  async #write(
    attemptId: string,
    phase: 'start' | 'terminal',
    record: LaunchAuditRecord,
  ): Promise<void> {
    if (!path.isAbsolute(this.root)) {
      throw Object.assign(new Error('Unsafe audit root.'), { code: 'AUDIT_PATH_INVALID' });
    }
    const rootStat = await lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw Object.assign(new Error('Unsafe audit root.'), { code: 'AUDIT_PATH_INVALID' });
    }
    const canonicalRoot = await realpath(this.root);
    let directory = this.root;
    for (const segment of ['launch-audits', record.launchKey.slice(0, 2), record.launchKey]) {
      directory = path.join(directory, segment);
      await mkdir(directory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      });
      const stat = await lstat(directory);
      const canonical = await realpath(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !pathWithin(canonicalRoot, canonical)) {
        throw Object.assign(new Error('Unsafe audit directory.'), { code: 'AUDIT_PATH_INVALID' });
      }
    }
    const target = path.join(directory, `${attemptId}.${phase}.json`);
    const temporary = path.join(directory, `.${attemptId}.${phase}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      const temporaryStat = await lstat(temporary);
      if (
        temporaryStat.isSymbolicLink() ||
        !temporaryStat.isFile() ||
        !pathWithin(canonicalRoot, await realpath(temporary))
      ) {
        throw Object.assign(new Error('Unsafe audit temporary file.'), {
          code: 'AUDIT_PATH_INVALID',
        });
      }
      try {
        await lstat(target);
        throw Object.assign(new Error('Audit record already exists.'), { code: 'EEXIST' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      await link(temporary, target);
      const targetStat = await lstat(target);
      if (
        targetStat.isSymbolicLink() ||
        !targetStat.isFile() ||
        !pathWithin(canonicalRoot, await realpath(target))
      ) {
        throw Object.assign(new Error('Unsafe audit target.'), { code: 'AUDIT_PATH_INVALID' });
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export class ExecutionService {
  readonly #approvals: HostApprovalStore;
  constructor(
    readonly dependencies: {
      executors: ExecutorRegistry;
      runtimes: RuntimeAdapterRegistry;
      routes: RouteMaterializer;
      privateRouteConsumption?: 'required' | 'none';
      audit?: LaunchAuditStore;
      approvals?: HostApprovalStore;
    },
  ) {
    this.#approvals = dependencies.approvals ?? new HostApprovalStore();
  }
  hostApprovalRequest(
    input: Omit<ExecuteInput, 'artifact' | 'hostApproval' | 'tty' | 'approvalNonce'>,
    nonce: string,
  ): HostApprovalRequest {
    const descriptor = parseLaunchDescriptor(input.descriptor);
    const reason = sanitizeHostReason(descriptor.elevationAudit.reason ?? '');
    return Object.freeze({
      requestDigest: sha256Canonical({
        launchKey: descriptor.launchKey,
        cwd: canonicalPath(input.cwd),
        executor: 'host',
      }),
      nonce,
      reason,
    });
  }
  async execute(input: ExecuteInput): Promise<ProcessResult> {
    const descriptor = parseLaunchDescriptor(input.descriptor);
    if (input.approveHost && descriptor.executor.name !== 'host') {
      fail(
        'HOST_APPROVAL_SCOPE_INVALID',
        'Noninteractive host approval is valid only for an explicit host launch.',
      );
    }
    if (input.capability !== undefined) {
      try {
        validateRuntimeCapabilityBinding(input.capability, {
          manifestKey: input.capability.manifestKey,
          launchKey: descriptor.launchKey,
          runtime: descriptor.runtime,
          identity: {
            ...descriptor.identity,
            nativeRuntimeRootDigest: descriptor.nativeRuntimeRootDigest,
          },
          binding: { ...descriptor.binding, selection: descriptor.selection },
          executor: descriptor.executor.name,
        });
      } catch {
        fail(
          'RUNTIME_CAPABILITY_INVALID',
          'Execution requires capability authority bound exactly to the current launch.',
        );
      }
    }
    let artifact: RuntimeSkillArtifactReference;
    try {
      artifact = parseRuntimeSkillArtifactReference(input.artifact);
    } catch {
      return fail(
        'RUNTIME_ARTIFACT_BINDING_INVALID',
        'Execution requires an exact valid v5 runtime artifact reference.',
      );
    }
    if (artifact.runtime !== descriptor.runtime) {
      fail(
        'RUNTIME_ARTIFACT_BINDING_INVALID',
        'The runtime artifact does not match the selected runtime.',
      );
    }
    if (input.expectedLaunchKey !== undefined && input.expectedLaunchKey !== descriptor.launchKey) {
      fail(
        'LAUNCH_RESTART_REQUIRED',
        'Launch rights or binding changed; create a new launch and restart.',
        { restartRequired: true },
      );
    }
    const privateEnvironment = validatePrivateLaunch(descriptor, input.privateLaunch);
    const executor = this.dependencies.executors.get(descriptor.executor.name);
    await executor.assertReady();
    if (descriptor.runtime === 'pi' && descriptor.routes.mcp.allow.length > 0) {
      fail(
        'RUNTIME_CAPABILITY_UNSUPPORTED',
        'The Pi runtime has no supported native MCP client integration.',
        {
          runtime: 'pi',
          capability: 'mcp',
          remediation: 'Use Claude for this MCP-enabled launch, or remove the MCP route selection.',
        },
      );
    }
    if (descriptor.executor.name === 'host') {
      if (!input.approveHost && !input.tty?.direct) {
        fail('HOST_TTY_REQUIRED', 'Host execution requires a direct TTY.');
      }
      const nonce = input.hostApproval?.nonce ?? input.approvalNonce ?? '';
      this.#approvals.consume(this.hostApprovalRequest(input, nonce), input.hostApproval);
    }
    const runtime = this.dependencies.runtimes.get(descriptor.runtime);
    if (runtime.modelTriggerableTools?.length) {
      if (!input.capability) {
        fail(
          'RUNTIME_CAPABILITY_REQUIRED',
          'Model-triggerable runtime tools require immutable launch capability authority.',
        );
      }
      const admitted = new Set(input.capability.tools.map((tool) => tool.name));
      if (runtime.modelTriggerableTools.some((tool) => !admitted.has(tool))) {
        fail(
          'RUNTIME_CAPABILITY_INVALID',
          'Every model-triggerable runtime tool requires explicit capability admission.',
        );
      }
    }
    const routes =
      this.dependencies.privateRouteConsumption === 'none'
        ? Object.freeze({})
        : validateRuntimeRoutes(
            descriptor,
            input.cwd,
            await this.dependencies.routes.materialize(descriptor, input.cwd),
          );
    const audit = this.dependencies.audit;
    let attemptId: string | undefined;
    if (audit) {
      try {
        attemptId = await audit.start(launchAuditStart(descriptor, artifact));
      } catch {
        fail(
          'AUDIT_START_WRITE_FAILED',
          'The immutable launch attempt audit could not be persisted.',
        );
      }
    }
    try {
      const prepared = await runtime.prepare({
        descriptor,
        routes,
        ...(input.capability ? { capability: input.capability } : {}),
        ...(input.runtimeStatusEnvelope ? { statusEnvelope: input.runtimeStatusEnvelope } : {}),
        ...(input.runtimeLaunchBinding ? { launchBinding: input.runtimeLaunchBinding } : {}),
      });
      let result: ProcessResult;
      try {
        if (
          (!path.win32.isAbsolute(prepared.executable) &&
            !path.posix.isAbsolute(prepared.executable)) ||
          prepared.argv.length > 256 ||
          prepared.argv.some((argument) => argument.length > 8192)
        ) {
          fail(
            'PROCESS_REQUEST_INVALID',
            'Runtime adapter produced an untrusted executable or unbounded argv.',
          );
        }
        const request = {
          executable: prepared.executable,
          argv: prepared.argv,
          cwd: input.cwd,
          environment: Object.freeze({
            ...sanitizedEnvironment(input.environment, prepared.environment),
            ...runtimeRouteEnvironment(routes),
            ...privateEnvironment,
          }),
          maxOutputBytes: 65_536,
          ...(input.signal ? { signal: input.signal } : {}),
        };
        await executor.assertReady();
        result = await executor.execute(request);
      } finally {
        await prepared.shutdown?.();
      }
      if (audit && attemptId) {
        try {
          await audit.terminal(attemptId, launchAuditTerminal(descriptor, { result }));
        } catch {
          fail(
            'AUDIT_TERMINAL_WRITE_FAILED',
            'The terminal launch audit could not be persisted unambiguously; the process was not retried.',
          );
        }
      }
      return result;
    } catch (error) {
      if (error instanceof ExecutionError && error.code === 'AUDIT_TERMINAL_WRITE_FAILED') {
        throw error;
      }
      if (audit && attemptId) {
        try {
          await audit.terminal(attemptId, launchAuditTerminal(descriptor, { error }));
        } catch {
          fail(
            'AUDIT_TERMINAL_WRITE_FAILED',
            'The terminal launch audit could not be persisted unambiguously; the process was not retried.',
          );
        }
      }
      throw error;
    }
  }
}

function launchAuditStart(
  descriptor: LaunchDescriptor,
  artifact: RuntimeSkillArtifactReference,
): LaunchAuditStartRecord {
  const reason =
    descriptor.elevationAudit.reason === null
      ? null
      : sanitizeHostReason(descriptor.elevationAudit.reason);
  return Object.freeze({
    schemaVersion: 1,
    phase: 'start',
    launchKey: descriptor.launchKey,
    runtime: descriptor.runtime,
    executor: descriptor.executor.name,
    identity: descriptor.identity.name,
    identityDomain: descriptor.identity.domain,
    mode: descriptor.mode,
    selectionSource: descriptor.selection.source,
    projectId: descriptor.binding.projectId,
    repositoryId: descriptor.binding.repositoryId,
    manifestKey: artifact.manifestKey,
    artifactKey: artifact.artifactKey,
    fileMapHash: artifact.fileMapHash,
    elevated: descriptor.elevationAudit.elevated,
    reason,
  });
}
function safeAuditErrorCode(error: unknown): string {
  const code =
    error instanceof ExecutionError ? error.code : (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : 'PROCESS_FAILED';
}
function launchAuditTerminal(
  descriptor: LaunchDescriptor,
  outcome: { result: ProcessResult } | { error: unknown },
): LaunchAuditTerminalRecord {
  return Object.freeze(
    'result' in outcome
      ? {
          schemaVersion: 1,
          phase: 'terminal',
          launchKey: descriptor.launchKey,
          outcome: 'result',
          exitCode: outcome.result.exitCode,
          truncated: outcome.result.truncated,
          errorCode: null,
        }
      : {
          schemaVersion: 1,
          phase: 'terminal',
          launchKey: descriptor.launchKey,
          outcome: 'failure',
          exitCode: null,
          truncated: null,
          errorCode: safeAuditErrorCode(outcome.error),
        },
  );
}

function canonicalNativeRoot(value: string): string {
  const windows = path.win32.isAbsolute(value);
  if (!windows && !path.posix.isAbsolute(value)) {
    fail(
      'PRIVATE_LAUNCH_BINDING_MISMATCH',
      'Private runtime launch data does not match the launch descriptor.',
    );
  }
  const normalized = windows
    ? path.win32.normalize(value).replaceAll('\\', '/').toLowerCase()
    : path.posix.normalize(value);
  return normalized.replace(/\/$/u, '');
}
function validatePrivateLaunch(
  descriptor: LaunchDescriptor,
  privateLaunch: PrivateRuntimeLaunch | undefined,
): Readonly<Record<string, string>> {
  if (privateLaunch === undefined) {
    return Object.freeze({});
  }
  const canonicalRoot = canonicalNativeRoot(privateLaunch.nativeRuntimeRoot);
  if (
    privateLaunch.launchKey !== descriptor.launchKey ||
    privateLaunch.runtime !== descriptor.runtime ||
    privateLaunch.identity.name !== descriptor.identity.name ||
    privateLaunch.identity.domain !== descriptor.identity.domain ||
    sha256Canonical(canonicalRoot) !== descriptor.nativeRuntimeRootDigest
  ) {
    fail(
      'PRIVATE_LAUNCH_BINDING_MISMATCH',
      'Private runtime launch data does not match the launch descriptor.',
    );
  }
  const variable = descriptor.runtime === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'PI_CODING_AGENT_DIR';
  return Object.freeze({ [variable]: privateLaunch.nativeRuntimeRoot });
}

function canonicalPath(value: string): string {
  return path.win32.isAbsolute(value)
    ? path.win32.normalize(value).replaceAll('\\', '/').toLowerCase()
    : path.resolve(value).replaceAll('\\', '/');
}
function within(candidate: string, root: string): boolean {
  const relative = path.win32.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative))
  );
}
function routeKeyLabel(key: string): string {
  if (
    /^git:[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key) ||
    /^provider-[a-z0-9][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key) ||
    /^ssh:[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key) ||
    /^mcp:[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key)
  ) {
    return key;
  }
  fail('PRIVATE_ROUTE_KEY_INVALID', 'Private route keys must be bounded trusted labels.');
}
function expectedRuntimeRouteKeys(descriptor: LaunchDescriptor): ReadonlySet<string> {
  return new Set<string>([
    `git:${descriptor.routes.gitAuthor}`,
    ...Object.entries(descriptor.routes.providers).map(
      ([provider, label]) => `provider-${provider}:${label}`,
    ),
    ...(descriptor.routes.ssh ? [`ssh:${descriptor.routes.ssh}`] : []),
    ...descriptor.routes.mcp.allow.map((label) => `mcp:${label}`),
  ]);
}
function validateRuntimeRoutePath(value: string, cwd: string): string {
  if (/[\0-\x1F\x7F]/u.test(value)) {
    fail('PRIVATE_ROUTE_PATH_INVALID', 'Private route paths must not contain control characters.');
  }
  if (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
    fail('PRIVATE_ROUTE_PATH_INVALID', 'Private route paths must be absolute state-local paths.');
  }
  const normalized = path.win32.isAbsolute(value)
    ? path.win32.normalize(value).replaceAll('\\', '/')
    : path.posix.normalize(value);
  if (within(canonicalPath(normalized), canonicalPath(cwd))) {
    fail(
      'PRIVATE_ROUTE_PATH_INVALID',
      'Private route paths must not point into the project checkout.',
    );
  }
  return normalized;
}
function validateRuntimeRoutes(
  descriptor: LaunchDescriptor,
  cwd: string,
  routes: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const expected = expectedRuntimeRouteKeys(descriptor);
  const validated: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(routes)) {
    const key = routeKeyLabel(rawKey);
    if (!expected.has(key)) {
      fail(
        'PRIVATE_ROUTE_KEY_INVALID',
        'Private route keys must match the selected launch routes.',
      );
    }
    validated[key] = validateRuntimeRoutePath(rawValue, cwd);
  }
  for (const key of expected) {
    if (!Object.hasOwn(validated, key)) {
      fail(
        'PRIVATE_ROUTE_MISSING',
        'Private route materialization is incomplete for the selected launch.',
      );
    }
  }
  return Object.freeze(validated);
}
function runtimeRouteEnvironment(
  routes: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  const normalizedRouteKeys = new Set<string>();
  for (const routeKey of Object.keys(routes)) {
    const [kind, label] = routeKey.split(':', 2) as [string, string];
    const environmentKey =
      kind === 'git'
        ? 'MPX_RUNTIME_ROUTE_GIT_AUTHOR'
        : kind === 'ssh'
          ? 'MPX_RUNTIME_ROUTE_SSH'
          : kind === 'mcp'
            ? `MPX_RUNTIME_ROUTE_MCP_${label.replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase()}`
            : `MPX_RUNTIME_ROUTE_PROVIDER_${kind
                .slice('provider-'.length)
                .replace(/[^A-Za-z0-9]+/gu, '_')
                .toUpperCase()}`;
    const folded = environmentKey.toLowerCase();
    if (normalizedRouteKeys.has(folded)) {
      fail('PRIVATE_ROUTE_ENVIRONMENT_COLLISION', 'Private route environment keys are ambiguous.');
    }
    normalizedRouteKeys.add(folded);
  }
  const assign = (key: string, value: string): void => {
    const collision = Object.keys(environment).find(
      (existing) => existing.toLowerCase() === key.toLowerCase(),
    );
    if (collision) {
      fail('PRIVATE_ROUTE_ENVIRONMENT_COLLISION', 'Private route environment keys are ambiguous.');
    }
    environment[key] = value;
  };
  for (const [key, value] of Object.entries(routes)) {
    const [kind] = key.split(':', 2) as [string, string];
    if (kind === 'git') {
      assign('MPX_RUNTIME_ROUTE_GIT_AUTHOR', value);
      assign('GIT_CONFIG_GLOBAL', path.join(value, 'gitconfig').replaceAll('\\', '/'));
    } else if (kind === 'provider-github') {
      assign('MPX_RUNTIME_ROUTE_PROVIDER_GITHUB', value);
      assign('GH_CONFIG_DIR', value);
    } else if (kind === 'provider-gitlab') {
      assign('MPX_RUNTIME_ROUTE_PROVIDER_GITLAB', value);
      assign('GLAB_CONFIG_DIR', value);
    } else if (kind === 'ssh') {
      if (value.length > 4_000 || /["\r\n\0]/u.test(value)) {
        fail(
          'PRIVATE_ROUTE_PATH_INVALID',
          'The SSH route path cannot be safely passed to the native client.',
        );
      }
      assign('MPX_RUNTIME_ROUTE_SSH', value);
      assign('GIT_SSH_COMMAND', `ssh -F "${path.join(value, 'config').replaceAll('\\', '/')}"`);
    } else if (kind === 'mcp') {
      // MCP descriptors are consumed explicitly by supported runtime argv, never via ambient environment.
    } else {
      fail(
        'PRIVATE_ROUTE_CONSUMER_UNAVAILABLE',
        'No concrete native consumer is available for a selected private route.',
      );
    }
  }
  return Object.freeze(environment);
}
export interface FileInspection {
  readonly file: boolean;
  readonly realpath: string;
  readonly content?: string;
}
const piCliRelative = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const simpleFnmPiWrapper = `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec "$basedir/node" "$basedir/${piCliRelative}" "$@"\n`;
const npmFnmPiWrapper = [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  '',
  'case `uname` in',
  '    *CYGWIN*|*MINGW*|*MSYS*)',
  '        if command -v cygpath > /dev/null 2>&1; then',
  '            basedir=`cygpath -w "$basedir"`',
  '        fi',
  '    ;;',
  'esac',
  '',
  'if [ -x "$basedir/node" ]; then',
  `  exec "$basedir/node"  "$basedir/${piCliRelative}" "$@"`,
  'else ',
  `  exec node  "$basedir/${piCliRelative}" "$@"`,
  'fi',
  '',
].join('\n');
function knownFnmPiWrapper(content: string): boolean {
  const normalized = content.replaceAll('\r\n', '\n');
  return normalized === simpleFnmPiWrapper || normalized === npmFnmPiWrapper;
}
export async function locateTrustedExecutable(input: {
  candidates: readonly string[];
  projectRoot: string;
  trustedRoots: readonly string[];
  nodeExecutable: string;
  platform: NodeJS.Platform;
  knownWrapper?: 'pi-fnm';
  /** Canonical home directory. Enables only the verified Windows FNM Pi installation exception. */
  homeDirectory?: string;
  inspect(file: string): Promise<FileInspection>;
}): Promise<{ executable: string; argvPrefix: readonly string[] }> {
  const project = canonicalPath(input.projectRoot);
  const roots = input.trustedRoots.map(canonicalPath);
  const home = input.homeDirectory ? canonicalPath(input.homeDirectory) : undefined;
  for (const candidate of input.candidates) {
    if (!path.win32.isAbsolute(candidate) && !path.posix.isAbsolute(candidate)) {
      continue;
    }
    const lower = candidate.toLowerCase();
    if (/\.(?:cmd|bat|ps1)$/u.test(lower)) {
      continue;
    }
    const inspected = await input.inspect(candidate).catch(() => undefined);
    if (!inspected?.file) {
      continue;
    }
    const real = canonicalPath(inspected.realpath);
    const projectBlocked = within(real, project);
    const possibleHomeFnmWrapper =
      projectBlocked &&
      input.platform === 'win32' &&
      input.knownWrapper === 'pi-fnm' &&
      home !== undefined &&
      project === home &&
      real === canonicalPath(candidate) &&
      path.win32.basename(real).toLowerCase() === 'pi' &&
      inspected.content !== undefined &&
      Buffer.byteLength(inspected.content) <= 4096 &&
      knownFnmPiWrapper(inspected.content);
    if ((projectBlocked && !possibleHomeFnmWrapper) || !roots.some((root) => within(real, root))) {
      continue;
    }
    const base = path.win32.basename(real).toLowerCase();
    if (/^mpx(?:\.|$)/u.test(base) || /(?:^|\s)mpx(?:\s|$)/u.test(inspected.content ?? '')) {
      continue;
    }
    if (/\.(?:mjs|cjs|js)$/u.test(real)) {
      const node = canonicalPath(input.nodeExecutable);
      if (
        !path.win32.isAbsolute(input.nodeExecutable) ||
        !roots.some((root) => within(node, root)) ||
        within(node, project)
      ) {
        continue;
      }
      const inspectedNode = await input.inspect(input.nodeExecutable).catch(() => undefined);
      if (!inspectedNode?.file || canonicalPath(inspectedNode.realpath) !== node) {
        continue;
      }
      return Object.freeze({
        executable: inspectedNode.realpath,
        argvPrefix: [inspected.realpath],
      });
    }
    if (inspected.content?.startsWith('#!')) {
      if (
        input.knownWrapper !== 'pi-fnm' ||
        Buffer.byteLength(inspected.content) > 4096 ||
        !knownFnmPiWrapper(inspected.content)
      ) {
        continue;
      }
      const directory = path.win32.dirname(inspected.realpath),
        nodeFiles = (input.platform === 'win32' ? ['node', 'node.exe'] : ['node']).map((name) =>
          path.win32.join(directory, name).replaceAll('\\', '/'),
        ),
        cliFile = path.win32
          .join(
            directory,
            'node_modules',
            '@earendil-works',
            'pi-coding-agent',
            'dist',
            'bundle',
            'cli.js',
          )
          .replaceAll('\\', '/');
      const [nodeInspections, cliInspection] = await Promise.all([
        Promise.all(
          nodeFiles.map(async (file) => ({
            file,
            inspection: await input.inspect(file).catch(() => undefined),
          })),
        ),
        input.inspect(cliFile).catch(() => undefined),
      ]);
      const currentNode = canonicalPath(input.nodeExecutable);
      const currentNodeInspection = await input
        .inspect(input.nodeExecutable)
        .catch(() => undefined);
      const verifiedCurrentNode =
        path.win32.isAbsolute(input.nodeExecutable) &&
        currentNodeInspection?.file === true &&
        canonicalPath(currentNodeInspection.realpath) === currentNode &&
        roots.some((root) => within(currentNode, root));
      const homeInstallException =
        possibleHomeFnmWrapper &&
        verifiedCurrentNode &&
        path.win32.dirname(real) === path.win32.dirname(currentNode);
      const existingNodeSiblings = nodeInspections.filter(({ inspection }) => inspection?.file);
      const trustedNodes = nodeInspections.filter(({ file, inspection }) => {
        const canonicalFile = canonicalPath(file);
        return (
          inspection?.file &&
          canonicalPath(inspection.realpath) === canonicalFile &&
          roots.some((root) => within(canonicalFile, root)) &&
          (!within(canonicalFile, project) ||
            (homeInstallException && canonicalFile === currentNode))
        );
      });
      const canonicalCli = canonicalPath(cliFile);
      if (
        trustedNodes.length !== 1 ||
        (homeInstallException && existingNodeSiblings.length !== 1) ||
        (homeInstallException && canonicalPath(trustedNodes[0]!.file) !== currentNode) ||
        !cliInspection?.file ||
        canonicalPath(cliInspection.realpath) !== canonicalCli ||
        !roots.some((root) => within(canonicalCli, root)) ||
        (within(canonicalCli, project) && !homeInstallException)
      ) {
        continue;
      }
      return Object.freeze({
        executable: trustedNodes[0]!.inspection!.realpath,
        argvPrefix: [cliInspection.realpath],
      });
    }
    return Object.freeze({ executable: inspected.realpath, argvPrefix: [] });
  }
  return fail(
    'TRUSTED_EXECUTABLE_NOT_FOUND',
    'No trusted absolute runtime executable or Node entry was found.',
  );
}

const ENV_ALLOW = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  // Windows OpenSSH reads ProgramData before initializing diagnostic output.
  'ProgramData',
  'PROGRAMDATA',
  'TERM',
  'COLORTERM',
  'WT_SESSION',
]);
const TRUSTED_LAUNCH_ENV_ALLOW = new Set([
  'MPX_RUNTIME',
  'MPX_ACTIVE_CONTENT_ROOT',
  'MPX_ACTIVE_CONTENT_MANIFEST',
  'MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY',
  'MPX_COMPILED_AGENTS_DIR',
  'MPX_IDENTITY',
  'MPX_MODE',
  'MPX_REPOSITORY_PROVIDER',
  'MPX_ISSUES_PROVIDER',
  'MPX_SESSION_LIFECYCLE_BINDING_ID',
  'MPX_SESSION_LIFECYCLE_EVENT_DIR',
]);
export function sanitizedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  launch: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !TRUSTED_LAUNCH_ENV_ALLOW.has(key) &&
      (ENV_ALLOW.has(key) ||
        /^MPX_(?:LAUNCH|CONTEXT|PROJECT|REPOSITORY|WORKSPACE|RUNTIME)_/u.test(key))
    ) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(launch)) {
    if (
      TRUSTED_LAUNCH_ENV_ALLOW.has(key) ||
      /^MPX_(?:LAUNCH|CONTEXT|PROJECT|REPOSITORY|WORKSPACE|RUNTIME)_/u.test(key)
    ) {
      result[key] = value;
    }
  }
  return Object.freeze(result);
}

export interface LaunchExecutionAudit {
  readonly schemaVersion: 1;
  readonly launchKey: string;
  readonly runtime: 'claude' | 'pi';
  readonly executor: 'docker' | 'host';
  readonly binding: LaunchDescriptor['binding'];
  readonly elevated: boolean;
  readonly reason: string | null;
  readonly outcome: 'started' | 'failed';
  readonly errorCode: string | null;
}
export function createLaunchExecutionAudit(
  descriptorInput: LaunchDescriptor,
  outcome: { started: boolean; errorCode?: string },
): Readonly<LaunchExecutionAudit> {
  const descriptor = parseLaunchDescriptor(descriptorInput);
  return Object.freeze({
    schemaVersion: 1,
    launchKey: descriptor.launchKey,
    runtime: descriptor.runtime,
    executor: descriptor.executor.name,
    binding: Object.freeze({ ...descriptor.binding }),
    elevated: descriptor.elevationAudit.elevated,
    reason:
      descriptor.elevationAudit.reason === null
        ? null
        : sanitizeHostReason(descriptor.elevationAudit.reason),
    outcome: outcome.started ? 'started' : 'failed',
    errorCode: outcome.errorCode ?? null,
  });
}
export function compactLaunchBanner(descriptorInput: LaunchDescriptor): string {
  const descriptor = parseLaunchDescriptor(descriptorInput);
  return `[mpx ${descriptor.runtime}/${descriptor.executor.name} ${descriptor.launchKey.slice(0, 12)}${descriptor.elevationAudit.elevated ? ' ELEVATED' : ''}]`;
}

export * from './sbx-client.js';
