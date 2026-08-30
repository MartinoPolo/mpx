import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PreparationPlan, PreparationStep } from '@mpx/config';
import { isPathWithinRoot, MpxError } from '@mpx/core';
import type { ResolvedExecutable } from './trusted-executable.js';

export type PreparationStatus =
  'preparing' | 'cancelling' | 'ready' | 'failed' | 'cancelled' | 'unknown';
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';
export type ConfiguredPackageManager = PackageManager | 'auto' | 'none';

export interface PreparationEvidence {
  /** Canonical identity (normally the real Git common directory), not a checkout spelling. */
  repositoryIdentity: string;
  head: string;
  configHash: string;
  packageManifestHash: string;
  lockfileHashes: readonly { path: string; hash: string }[];
  resolvedPackageScriptBody?: string;
}

export interface PreparationEvidenceAdapter {
  capture(request: {
    worktreeRoot: string;
    cwd: string;
    step: PreparationStep;
  }): Promise<PreparationEvidence>;
}

export interface SpawnRequest {
  argv: readonly string[];
  /** Approval-time immutable executable evidence, revalidated by the production adapter immediately before spawn. */
  executable?: ResolvedExecutable;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  environmentNames: readonly string[];
  timeoutMs: number;
  maxOutputBytes?: number;
  shell: false;
  onStarted: (process: OwnedProcess) => Promise<void>;
}

export interface SpawnResult {
  exitCode: number | null;
  output: string | Buffer;
  timedOut?: boolean;
  pid?: number;
  startFingerprint?: string;
  /** Whether timeout cleanup was identity-verified; unknown means only the directly-owned child handle was signalled. */
  terminationState?: 'terminated' | 'unknown';
}

export interface OwnedProcess {
  pid: number;
  startFingerprint: string;
  ownerToken?: string;
}
export interface InspectedProcess {
  startFingerprint: string;
  owner: 'mpx' | 'other';
  ownerToken?: string;
}

export interface PreparationExecutionAdapter {
  /** Resolves a command to a canonical regular file and hashes its bytes. */
  resolveExecutable(command: string, cwd: string): Promise<ResolvedExecutable>;
  /** Must execute argv directly. Implementations must reject shell execution. */
  spawn(request: SpawnRequest): Promise<SpawnResult>;
  /** Starts an inert MPX worker, verifies it, durably registers its identity, and only then activates it. */
  startBackground(
    request: BackgroundPreparationRequest,
    onVerified: (process: OwnedProcess) => Promise<void>,
  ): Promise<OwnedProcess>;
}

export interface BackgroundPreparationRequest {
  key: string;
  /** Identifies the already-created run that the worker must resume. */
  runId: string;
  approval: PreparationApproval;
  packageAutomationApproval?: string;
  explicitExecutableApproval?: string;
  plan: PreparationPlan;
  worktreeRoot: string;
  packageManager: PackageManager;
  logDirectory: string;
  /** Names only; the worker may obtain their current values from its inherited environment. */
  environmentNames: readonly string[];
}

export interface PreparationStoreAdapter {
  load(key: string): Promise<PreparationState | undefined>;
  /** Serializes writers, reloads the revision, runs revalidation while still locked, then replaces. */
  compareAndSwap(
    key: string,
    expectedRevision: number | undefined,
    next: PreparationState,
    revalidate?: () => Promise<void>,
  ): Promise<boolean>;
  /** Writes a complete, already bounded and redacted diagnostic log atomically. */
  writeLogAtomic(path: string, content: string): Promise<void>;
}

export interface PreparationClockAdapter {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface PreparationProcessAdapter {
  inspect(pid: number): Promise<InspectedProcess | undefined>;
  terminateTree(pid: number, expected?: OwnedProcess): Promise<void>;
}

export interface PreparationAdapters {
  evidence: PreparationEvidenceAdapter;
  execution: PreparationExecutionAdapter;
  store: PreparationStoreAdapter;
  clock: PreparationClockAdapter;
  process: PreparationProcessAdapter;
  paths: { canonicalize(path: string): Promise<string> };
}

export interface PreparationStepApproval {
  id: string;
  kind: 'package' | 'explicit-argv';
  digest: string;
}

export interface PreparationApproval {
  schemaVersion: 1;
  owner: 'mpx';
  steps: readonly PreparationStepApproval[];
}

export interface PreparationStepState {
  id: string;
  status: PreparationStatus;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  logPath?: string;
  /** Redacted tail retained in state for diagnostics; always at most 4096 UTF-8 bytes. */
  logTail?: string;
  failure?: 'exit' | 'timeout' | 'approval' | 'execution';
  terminationState?: 'terminated' | 'unknown';
  process?: OwnedProcess;
}

export interface PreparationRunHistory {
  runId: string;
  status: PreparationStatus;
  execution: PreparationPlan['execution'];
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  steps: PreparationStepState[];
}

export interface PreparationState {
  schemaVersion: 2;
  owner: 'mpx';
  key: string;
  /** Unguessable identity for one execution attempt. */
  runId: string;
  /** Monotonically increasing compare-and-swap version. */
  revision: number;
  status: PreparationStatus;
  execution: PreparationPlan['execution'];
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  steps: PreparationStepState[];
  worker?: OwnedProcess;
  /** Immutable terminal attempts retained when an operator explicitly retries. */
  previousRuns?: PreparationRunHistory[];
}

export interface CreateApprovalRequest {
  plan: PreparationPlan;
  worktreeRoot: string;
  packageManager: PackageManager;
  environment: Readonly<Record<string, string | undefined>>;
}

export interface PrepareRequest extends CreateApprovalRequest {
  key: string;
  approval: PreparationApproval;
  packageAutomationApproval?: string;
  explicitExecutableApproval?: string;
  logDirectory: string;
  worker?: OwnedProcess;
}

function preparationError(code: string, message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function orderedSteps(plan: PreparationPlan): PreparationStep[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  return plan.order.map((id) => {
    const step = byId.get(id);
    if (!step) {
      throw preparationError(
        'PREPARATION_PLAN_INVALID',
        `Preparation order refers to unknown step ${id}.`,
      );
    }
    return step;
  });
}

function resolveCwd(root: string, relative: string | undefined): string {
  const cwd = path.resolve(root, relative ?? '.');
  if (!isPathWithinRoot(cwd, path.resolve(root))) {
    throw preparationError('PREPARATION_CWD_ESCAPE', 'Preparation step cwd escapes the worktree.');
  }
  return cwd;
}

function canonicalPathWithinRoot(candidate: string, root: string): boolean {
  const win = /^[A-Za-z]:[\\/]/u.test(candidate) || /^[A-Za-z]:[\\/]/u.test(root);
  const implementation = win ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const resolved = implementation.resolve(value);
    return win ? resolved.toLowerCase() : resolved;
  };
  const normalizedCandidate = normalize(candidate);
  const normalizedRoot = normalize(root);
  return (
    normalizedCandidate === normalizedRoot ||
    isPathWithinRoot(normalizedCandidate, normalizedRoot, { platform: win ? 'win32' : 'linux' })
  );
}

async function canonicalizeRootAndCwd(
  root: string,
  relative: string | undefined,
  adapters: PreparationAdapters,
): Promise<{ root: string; cwd: string }> {
  const resolvedRoot = path.resolve(root);
  const resolvedCwd = resolveCwd(root, relative);
  const canonicalRoot = await adapters.paths.canonicalize(resolvedRoot);
  const canonicalCwd = await adapters.paths.canonicalize(resolvedCwd);
  if (!canonicalPathWithinRoot(canonicalCwd, canonicalRoot)) {
    throw preparationError('PREPARATION_CWD_ESCAPE', 'Preparation step cwd escapes the worktree.');
  }
  return { root: canonicalRoot, cwd: canonicalCwd };
}

function argvFor(step: PreparationStep, manager: PackageManager): readonly string[] {
  if (step.uses === 'executable') {
    return [...step.argv];
  }
  if (step.uses === 'package-script') {
    return manager === 'yarn' ? [manager, 'run', step.script] : [manager, 'run', step.script];
  }
  switch (manager) {
    case 'pnpm':
      return ['pnpm', 'install', '--frozen-lockfile'];
    case 'npm':
      return ['npm', 'ci'];
    case 'yarn':
      return ['yarn', 'install', '--immutable'];
    case 'bun':
      return ['bun', 'install', '--frozen-lockfile'];
  }
}

const SAFE_ENVIRONMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SECRET_ENVIRONMENT =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|API_KEY|AUTH|COOKIE)(?:_|$)/iu;

function environmentNames(step: PreparationStep): string[] {
  const names = [...(step.environment ?? [])].sort();
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !SAFE_ENVIRONMENT.test(name) || SECRET_ENVIRONMENT.test(name))
  ) {
    throw preparationError(
      'PREPARATION_ENVIRONMENT_INVALID',
      'Preparation environment names are invalid or secret-bearing.',
    );
  }
  return names;
}

async function approvalMaterial(
  request: CreateApprovalRequest,
  adapters: PreparationAdapters,
  step: PreparationStep,
) {
  const { root, cwd } = await canonicalizeRootAndCwd(request.worktreeRoot, step.cwd, adapters);
  const argv = argvFor(step, request.packageManager);
  const names = environmentNames(step);
  const evidence = await adapters.evidence.capture({ worktreeRoot: root, cwd, step });
  const resolvedExecutable = await adapters.execution.resolveExecutable(argv[0]!, cwd);
  if (step.uses === 'package-script' && evidence.resolvedPackageScriptBody === undefined) {
    throw preparationError(
      'PREPARATION_SCRIPT_UNRESOLVED',
      `Package script ${step.script} could not be resolved.`,
    );
  }
  return {
    repositoryIdentity: evidence.repositoryIdentity,
    head: evidence.head,
    configHash: evidence.configHash,
    packageManifestHash: evidence.packageManifestHash,
    lockfileHashes: [...evidence.lockfileHashes].sort((a, b) => a.path.localeCompare(b.path)),
    resolvedPackageScriptBody:
      step.uses === 'package-script' ? evidence.resolvedPackageScriptBody : undefined,
    executable: resolvedExecutable,
    step: {
      id: step.id,
      uses: step.uses,
      argv: [
        resolvedExecutable.path,
        ...(resolvedExecutable.trustedPrefixArguments ?? []),
        ...argv.slice(1),
      ],
      cwd,
      environmentNames: names,
      timeoutSeconds: step.timeoutSeconds ?? 600,
      required: step.required ?? true,
    },
  };
}

/** Captures all mutable execution inputs. Values of approved environment variables are deliberately excluded. */
export async function createPreparationApproval(
  request: CreateApprovalRequest,
  adapters: PreparationAdapters,
): Promise<PreparationApproval> {
  const steps: PreparationStepApproval[] = [];
  for (const step of orderedSteps(request.plan)) {
    const material = await approvalMaterial(request, adapters, step);
    steps.push({
      id: step.id,
      kind: step.uses === 'executable' ? 'explicit-argv' : 'package',
      digest: digest(material),
    });
  }
  return { schemaVersion: 1, owner: 'mpx', steps };
}

/** Separate human confirmations; each digest is bound only to evidence of its privilege kind. */
export function preparationApprovalPhrases(approval: PreparationApproval): {
  packageAutomationApproval?: string;
  explicitExecutableApproval?: string;
} {
  const packageSteps = approval.steps.filter((step) => step.kind === 'package');
  const explicitSteps = approval.steps.filter((step) => step.kind === 'explicit-argv');
  return {
    ...(packageSteps.length === 0
      ? {}
      : {
          packageAutomationApproval: `APPROVE PACKAGE AUTOMATION ${digest({ schemaVersion: approval.schemaVersion, owner: approval.owner, kind: 'package', steps: packageSteps })}`,
        }),
    ...(explicitSteps.length === 0
      ? {}
      : {
          explicitExecutableApproval: `APPROVE EXPLICIT EXECUTABLES ${digest({ schemaVersion: approval.schemaVersion, owner: approval.owner, kind: 'explicit-argv', steps: explicitSteps })}`,
        }),
  };
}

/** @deprecated Use preparationApprovalPhrases so privilege kinds are never merged. */
export function preparationApprovalPhrase(approval: PreparationApproval): string {
  const phrases = preparationApprovalPhrases(approval);
  return (
    phrases.packageAutomationApproval ??
    phrases.explicitExecutableApproval ??
    `APPROVE WORKTREE PREPARATION ${digest(approval)}`
  );
}

function utf8Tail(text: string, maximum: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maximum) {
    return text;
  }
  let start = bytes.length - maximum;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}

function boundedRedactedLog(
  output: string | Buffer,
  environment: Readonly<Record<string, string>>,
  maximum: number,
): string {
  let text = Buffer.isBuffer(output) ? output.toString('utf8') : output;
  for (const value of Object.values(environment)
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)) {
    text = text.split(value).join('[REDACTED]');
  }
  return utf8Tail(text, maximum);
}

function exactProcess(actual: InspectedProcess | undefined, expected: OwnedProcess): boolean {
  return (
    typeof expected.ownerToken === 'string' &&
    expected.ownerToken.length > 0 &&
    actual?.owner === 'mpx' &&
    actual.startFingerprint === expected.startFingerprint &&
    actual.ownerToken === expected.ownerToken
  );
}

export class PreparationEngine {
  constructor(private readonly adapters: PreparationAdapters) {}

  async prepare(request: PrepareRequest): Promise<PreparationState> {
    const timestamp = this.adapters.clock.now();
    const steps = orderedSteps(request.plan);
    if (request.plan.execution !== 'none') {
      this.validateApprovalShape(request, steps);
    }
    const terminal = request.plan.execution === 'none';
    const state: PreparationState = {
      schemaVersion: 2,
      owner: 'mpx',
      key: request.key,
      runId: randomUUID(),
      revision: 1,
      status: terminal ? 'ready' : 'preparing',
      execution: request.plan.execution,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(terminal ? { finishedAt: timestamp } : {}),
      steps: steps.map((step) => ({ id: step.id, status: 'unknown' })),
    };
    if (!(await this.adapters.store.compareAndSwap(request.key, undefined, state))) {
      throw preparationError(
        'PREPARATION_STATE_CONFLICT',
        'A preparation state already exists for this key.',
      );
    }
    if (terminal) {
      return state;
    }
    const progress = { stepId: undefined as string | undefined };
    try {
      if (request.plan.execution === 'background') {
        return await this.startBackground(request, steps, state, progress);
      }
      return await this.execute(request, steps, state, progress);
    } catch (error) {
      await this.finalizeExecutionError(request.key, state.runId, progress.stepId);
      throw error;
    }
  }

  /** Starts a new attempt only from a verified terminal failure, retaining the prior run's facts. */
  async retry(request: PrepareRequest): Promise<PreparationState> {
    const steps = orderedSteps(request.plan);
    if (request.plan.execution !== 'none') {
      this.validateApprovalShape(request, steps);
    }
    const current = await this.adapters.store.load(request.key);
    if (!current) {
      throw preparationError('PREPARATION_STATE_MISSING', 'Preparation state does not exist.');
    }
    if (current.status !== 'failed' && current.status !== 'cancelled') {
      throw preparationError(
        'PREPARATION_RETRY_NOT_TERMINAL',
        'Only a verified failed or cancelled preparation can be retried.',
      );
    }
    const timestamp = this.adapters.clock.now();
    const terminal = request.plan.execution === 'none';
    const prior: PreparationRunHistory = {
      runId: current.runId,
      status: current.status,
      execution: current.execution,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      ...(current.finishedAt === undefined ? {} : { finishedAt: current.finishedAt }),
      steps: structuredClone(current.steps),
    };
    const replacement: PreparationState = {
      schemaVersion: 2,
      owner: 'mpx',
      key: request.key,
      runId: randomUUID(),
      revision: current.revision + 1,
      status: terminal ? 'ready' : 'preparing',
      execution: request.plan.execution,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(terminal ? { finishedAt: timestamp } : {}),
      steps: steps.map((step) => ({ id: step.id, status: 'unknown' })),
      previousRuns: [...(current.previousRuns ?? []), prior],
    };
    const revalidate = async () => {
      for (const [index, step] of steps.entries()) {
        const material = await approvalMaterial(request, this.adapters, step);
        if (digest(material) !== request.approval.steps[index]?.digest) {
          throw preparationError(
            'PREPARATION_APPROVAL_STALE',
            `Approval for preparation step ${step.id} is stale.`,
          );
        }
      }
    };
    if (
      !(await this.adapters.store.compareAndSwap(
        request.key,
        current.revision,
        replacement,
        revalidate,
      ))
    ) {
      throw preparationError(
        'PREPARATION_STATE_CONFLICT',
        'The preparation state changed before retry.',
      );
    }
    if (terminal) {
      return replacement;
    }
    const progress = { stepId: undefined as string | undefined };
    try {
      if (request.plan.execution === 'background') {
        return await this.startBackground(request, steps, replacement, progress);
      }
      return await this.execute(request, steps, replacement, progress);
    } catch (error) {
      await this.finalizeExecutionError(request.key, replacement.runId, progress.stepId);
      throw error;
    }
  }

  /** Resumes only an already-created run. Workers must never create replacement state. */
  async resume(request: PrepareRequest & { runId: string }): Promise<PreparationState> {
    const steps = orderedSteps(request.plan);
    this.validateApprovalShape(request, steps);
    const state = await this.adapters.store.load(request.key);
    if (!state || state.runId !== request.runId) {
      throw preparationError(
        'PREPARATION_RUN_STALE',
        'The preparation worker does not match the persisted run.',
      );
    }
    if (state.status !== 'preparing') {
      return state;
    }
    const progress = { stepId: undefined as string | undefined };
    try {
      return await this.execute(request, steps, state, progress);
    } catch (error) {
      await this.finalizeExecutionError(request.key, request.runId, progress.stepId);
      throw error;
    }
  }

  private async startBackground(
    request: PrepareRequest,
    steps: readonly PreparationStep[],
    initial: PreparationState,
    progress: { stepId: string | undefined },
  ): Promise<PreparationState> {
    let state = initial;
    for (const [index, step] of steps.entries()) {
      progress.stepId = step.id;
      const material = await approvalMaterial(request, this.adapters, step);
      if (digest(material) !== request.approval.steps[index]!.digest) {
        state = await this.mutateActive(state, (next) => {
          const fact = next.steps[index]!;
          fact.status = 'failed';
          fact.failure = 'approval';
          fact.finishedAt = this.adapters.clock.now();
          next.status = 'failed';
          next.finishedAt = this.adapters.clock.now();
        });
        throw preparationError(
          'PREPARATION_APPROVAL_STALE',
          `Approval for preparation step ${step.id} is stale.`,
        );
      }
    }
    const worker = await this.adapters.execution.startBackground(
      {
        key: request.key,
        runId: state.runId,
        approval: request.approval,
        ...(request.packageAutomationApproval === undefined
          ? {}
          : { packageAutomationApproval: request.packageAutomationApproval }),
        ...(request.explicitExecutableApproval === undefined
          ? {}
          : { explicitExecutableApproval: request.explicitExecutableApproval }),
        plan: request.plan,
        worktreeRoot: request.worktreeRoot,
        packageManager: request.packageManager,
        logDirectory: request.logDirectory,
        environmentNames: [...new Set(steps.flatMap(environmentNames))].sort(),
      },
      async (verified) => {
        const registered = await this.mutateActive(state, (next) => {
          next.worker = verified;
        });
        if (
          registered.runId !== state.runId ||
          registered.status !== 'preparing' ||
          registered.worker?.pid !== verified.pid ||
          registered.worker.startFingerprint !== verified.startFingerprint ||
          registered.worker.ownerToken !== verified.ownerToken
        ) {
          throw preparationError(
            'PREPARATION_RUN_SUPERSEDED',
            'The preparation run changed before worker activation.',
          );
        }
        state = registered;
      },
    );
    const current = await this.adapters.store.load(request.key);
    if (current?.runId !== state.runId || current.status !== 'preparing') {
      return current ?? state;
    }
    return current.worker
      ? current
      : this.mutateActive(current, (next) => {
          next.worker = worker;
        });
  }

  private async execute(
    request: PrepareRequest,
    steps: readonly PreparationStep[],
    initial: PreparationState,
    progress: { stepId: string | undefined },
  ): Promise<PreparationState> {
    let state = initial;
    for (const [index, step] of steps.entries()) {
      progress.stepId = step.id;
      if (state.status !== 'preparing') {
        return state;
      }
      const material = await approvalMaterial(request, this.adapters, step);
      if (digest(material) !== request.approval.steps[index]!.digest) {
        state = await this.mutateActive(state, (next) => {
          const fact = next.steps[index]!;
          fact.status = 'failed';
          fact.failure = 'approval';
          fact.finishedAt = this.adapters.clock.now();
          next.status = 'failed';
          next.finishedAt = this.adapters.clock.now();
        });
        throw preparationError(
          'PREPARATION_APPROVAL_STALE',
          `Approval for preparation step ${step.id} is stale.`,
        );
      }
      const { cwd } = await canonicalizeRootAndCwd(request.worktreeRoot, step.cwd, this.adapters);
      const names = environmentNames(step);
      const environment = Object.fromEntries(
        names
          .filter((name) => request.environment[name] !== undefined)
          .map((name) => [name, request.environment[name]!]),
      ) as Record<string, string>;
      state = await this.mutateActive(state, (next) => {
        const fact = next.steps[index]!;
        fact.status = 'preparing';
        fact.startedAt = this.adapters.clock.now();
      });
      if (state.status !== 'preparing') {
        return state;
      }
      const runId = state.runId;
      const result = await this.adapters.execution.spawn({
        argv: material.step.argv,
        executable: material.executable,
        cwd,
        environment,
        environmentNames: names,
        timeoutMs: (step.timeoutSeconds ?? 600) * 1000,
        maxOutputBytes: request.plan.logging.maxOutputBytes,
        shell: false,
        onStarted: async (owned) => {
          const registered = await this.mutateActive(state, (next) => {
            next.steps[index]!.process = owned;
          });
          if (registered.runId !== runId || registered.status !== 'preparing') {
            throw preparationError(
              'PREPARATION_RUN_SUPERSEDED',
              'The preparation run changed before process registration.',
            );
          }
          state = registered;
        },
      });
      const logPath = path.join(request.logDirectory, runId, `${step.id}.log`);
      const redactedLog = boundedRedactedLog(
        result.output,
        environment,
        request.plan.logging.maxOutputBytes,
      );
      await this.adapters.store.writeLogAtomic(logPath, redactedLog);
      const ownedProcess = state.steps[index]?.process;
      let timeoutTermination: 'terminated' | 'unknown' | undefined;
      if (result.timedOut) {
        timeoutTermination = result.terminationState ?? 'unknown';
        if (timeoutTermination === 'unknown') {
          timeoutTermination =
            ownedProcess && (await this.terminateIfOwned(ownedProcess)) ? 'terminated' : 'unknown';
        }
      }
      state = await this.mutateActive(state, (next) => {
        const fact = next.steps[index]!;
        fact.logPath = logPath;
        fact.logTail = utf8Tail(redactedLog, 4096);
        fact.exitCode = result.exitCode;
        fact.finishedAt = this.adapters.clock.now();
        if (result.timedOut) {
          fact.failure = 'timeout';
          fact.terminationState = timeoutTermination ?? 'unknown';
          if (timeoutTermination === 'terminated') {
            fact.status = 'failed';
            delete fact.process;
          } else {
            fact.status = 'unknown';
          }
        } else {
          delete fact.process;
          if (result.exitCode !== 0) {
            fact.status = 'failed';
            fact.failure = 'exit';
          } else {
            fact.status = 'ready';
          }
        }
      });
      if (state.status !== 'preparing') {
        return state;
      }
      const fact = state.steps[index]!;
      if (fact.status === 'unknown') {
        return this.finishActive(state, 'unknown');
      }
      if (fact.status === 'failed' && (step.required ?? true)) {
        return this.finishActive(state, 'failed');
      }
    }
    return this.finishActive(state, 'ready');
  }

  async cancel(key: string): Promise<PreparationState> {
    let state = await this.adapters.store.load(key);
    if (!state) {
      throw preparationError('PREPARATION_STATE_MISSING', 'Preparation state does not exist.');
    }
    let requiresVerifiedExit = false;
    while (state.status === 'preparing' || state.status === 'unknown') {
      requiresVerifiedExit ||=
        state.status === 'unknown' ||
        state.steps.some((step) => step.status === 'unknown' && step.process !== undefined);
      const claimed = this.nextState(state, (next) => {
        next.status = 'cancelling';
        delete next.finishedAt;
      });
      if (await this.adapters.store.compareAndSwap(key, state.revision, claimed)) {
        state = claimed;
        break;
      }
      const reloaded = await this.adapters.store.load(key);
      if (!reloaded) {
        throw preparationError('PREPARATION_STATE_MISSING', 'Preparation state does not exist.');
      }
      state = reloaded;
    }
    if (state.status !== 'cancelling') {
      return state;
    }
    const evidence = this.processEvidence(state);
    let status: 'cancelled' | 'unknown' = evidence.length > 0 ? 'cancelled' : 'unknown';
    for (const owned of evidence) {
      try {
        const inspected = await this.adapters.process.inspect(owned.pid);
        if (!inspected) {
          continue;
        }
        if (
          !exactProcess(inspected, owned) ||
          !(await this.terminateIfOwned(owned, requiresVerifiedExit))
        ) {
          status = 'unknown';
          break;
        }
      } catch {
        status = 'unknown';
        break;
      }
    }
    return this.finalizeCancellation(state, status);
  }

  async reconcile(key: string): Promise<PreparationState> {
    const state = await this.adapters.store.load(key);
    if (!state) {
      throw preparationError('PREPARATION_STATE_MISSING', 'Preparation state does not exist.');
    }
    if (state.status === 'cancelling') {
      return this.finalizeCancellation(state, 'unknown');
    }
    if (state.status !== 'preparing' && state.status !== 'unknown') {
      return state;
    }
    const evidence = this.processEvidence(state);
    let exactLive = false;
    let uncertain = false;
    for (const owned of evidence) {
      try {
        const inspected = await this.adapters.process.inspect(owned.pid);
        if (inspected) {
          if (exactProcess(inspected, owned)) {
            exactLive = true;
          } else {
            uncertain = true;
          }
        }
      } catch {
        uncertain = true;
      }
    }
    if (exactLive && !uncertain) {
      return state;
    }
    return this.finishActive(state, 'unknown');
  }

  private validateApprovalShape(request: PrepareRequest, steps: readonly PreparationStep[]): void {
    if (
      request.approval.schemaVersion !== 1 ||
      request.approval.owner !== 'mpx' ||
      request.approval.steps.length !== steps.length ||
      request.approval.steps.some(
        (approved, index) =>
          approved.id !== steps[index]?.id ||
          approved.kind !== (steps[index]?.uses === 'executable' ? 'explicit-argv' : 'package'),
      )
    ) {
      throw preparationError(
        'PREPARATION_APPROVAL_STALE',
        'Preparation approval does not match the deterministic plan.',
      );
    }
    const expected = preparationApprovalPhrases(request.approval);
    if (
      expected.packageAutomationApproval !== request.packageAutomationApproval ||
      expected.explicitExecutableApproval !== request.explicitExecutableApproval
    ) {
      throw preparationError(
        'PREPARATION_APPROVAL_STALE',
        'Every preparation privilege kind requires its own exact current approval.',
      );
    }
  }
  private async terminateIfOwned(owned: OwnedProcess, verifyGone = true): Promise<boolean> {
    let inspected: InspectedProcess | undefined;
    try {
      inspected = await this.adapters.process.inspect(owned.pid);
    } catch {
      return false;
    }
    if (!inspected) {
      return true;
    }
    if (!exactProcess(inspected, owned)) {
      return false;
    }
    try {
      await this.adapters.process.terminateTree(owned.pid, owned);
    } catch {
      return false;
    }
    if (!verifyGone) {
      return true;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const remaining = await this.adapters.process.inspect(owned.pid);
        if (!remaining) {
          return true;
        }
        if (!exactProcess(remaining, owned)) {
          return false;
        }
      } catch {
        return false;
      }
      await this.adapters.clock.sleep(25);
    }
    return false;
  }
  private processEvidence(state: PreparationState): OwnedProcess[] {
    const candidates = [
      ...(state.worker === undefined ? [] : [state.worker]),
      ...state.steps
        .filter(
          (step) =>
            (step.status === 'preparing' || step.status === 'unknown') &&
            step.process !== undefined,
        )
        .map((step) => step.process!),
    ];
    const seen = new Set<string>();
    return candidates.filter((process) => {
      const identity = `${process.pid}:${process.startFingerprint}:${process.ownerToken ?? ''}`;
      if (seen.has(identity)) {
        return false;
      }
      seen.add(identity);
      return true;
    });
  }
  private async finalizeExecutionError(
    key: string,
    runId: string,
    stepId: string | undefined,
  ): Promise<void> {
    for (;;) {
      const state = await this.adapters.store.load(key);
      if (!state || state.runId !== runId || state.status !== 'preparing') {
        return;
      }
      let unknown = false;
      for (const owned of this.processEvidence(state)) {
        try {
          if (await this.adapters.process.inspect(owned.pid)) {
            unknown = true;
          }
        } catch {
          unknown = true;
        }
      }
      const next = this.nextState(state, (candidate) => {
        candidate.status = unknown ? 'unknown' : 'failed';
        candidate.finishedAt = this.adapters.clock.now();
        const fact =
          candidate.steps.find((step) => step.id === stepId) ??
          candidate.steps.find((step) => step.status === 'preparing') ??
          candidate.steps.find((step) => step.status === 'unknown');
        if (fact) {
          fact.status = unknown ? 'unknown' : 'failed';
          fact.failure = 'execution';
          fact.finishedAt = this.adapters.clock.now();
          if (!unknown) {
            delete fact.process;
          }
        }
        if (!unknown) {
          delete candidate.worker;
        }
      });
      if (await this.adapters.store.compareAndSwap(key, state.revision, next)) {
        return;
      }
    }
  }
  private nextState(
    state: PreparationState,
    change: (next: PreparationState) => void,
  ): PreparationState {
    const next = structuredClone(state);
    change(next);
    next.revision = state.revision + 1;
    next.updatedAt = this.adapters.clock.now();
    return next;
  }
  private async mutateActive(
    state: PreparationState,
    change: (next: PreparationState) => void,
  ): Promise<PreparationState> {
    let current = state;
    for (;;) {
      if (current.runId !== state.runId || current.status !== 'preparing') {
        return current;
      }
      const next = this.nextState(current, change);
      if (await this.adapters.store.compareAndSwap(current.key, current.revision, next)) {
        return next;
      }
      const reloaded = await this.adapters.store.load(current.key);
      if (!reloaded) {
        return current;
      }
      current = reloaded;
    }
  }
  private async finishActive(
    state: PreparationState,
    status: 'ready' | 'failed' | 'unknown',
  ): Promise<PreparationState> {
    return this.mutateActive(state, (next) => {
      next.status = status;
      next.finishedAt = this.adapters.clock.now();
    });
  }
  private async finalizeCancellation(
    state: PreparationState,
    status: 'cancelled' | 'unknown',
  ): Promise<PreparationState> {
    if (state.status !== 'cancelling') {
      return state;
    }
    const next = this.nextState(state, (candidate) => {
      candidate.status = status;
      candidate.finishedAt = this.adapters.clock.now();
      for (const step of candidate.steps) {
        if (step.status === 'preparing' || step.status === 'unknown') {
          step.status = status === 'cancelled' ? 'cancelled' : 'unknown';
          step.finishedAt = this.adapters.clock.now();
          if (status === 'cancelled') {
            delete step.process;
          }
        }
      }
      if (status === 'cancelled') {
        delete candidate.worker;
      }
    });
    if (await this.adapters.store.compareAndSwap(state.key, state.revision, next)) {
      return next;
    }
    return (await this.adapters.store.load(state.key)) ?? state;
  }
}
