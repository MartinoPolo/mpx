import type { DiscoveredConfig, UserConfig } from '@mpx/config';
import { MpxError, type Diagnostic } from '@mpx/core';
import {
  canonicalRuntimeArgs,
  resolveLaunch,
  validateLaunchDomain,
  resolveLaunchSelection,
  serializeLaunchPublic,
  type HostApproval,
  type LaunchDescriptor,
  type LaunchSelection,
  type ResolveLaunchSelectionInput,
  type ShortLaunchAlias,
} from '@mpx/launch';
import type {
  CanonicalSkill,
  CatalogSkill,
  ProjectSkill,
  ResolvedManifest,
  RuntimeSkillArtifact,
} from '@mpx/skills/contracts';
import { parseStatusSnapshot, type StatusSnapshot } from '@mpx/status';
import { resolveLaunchSkills } from './launch-skill-resolution.js';

export type LaunchApplicationOperation = 'explain' | 'launch';
export interface LaunchApplicationRequest {
  readonly operation: LaunchApplicationOperation;
  readonly cwd: string;
  readonly catalogRoot: string;
  readonly userConfig: UserConfig;
  readonly runtime?: 'claude' | 'pi';
  readonly identity?: string;
  readonly alias?: ShortLaunchAlias;
  readonly mode?: string;
  readonly executor?: 'host' | 'docker';
  readonly workspace?: 'clone' | 'host-worktree' | 'direct';
  readonly networkPolicy?: string;
  readonly preset?: string;
  readonly runtimeArgs?: readonly string[];
}
export interface LaunchCandidateRequest {
  readonly operation: 'explain';
  readonly cwd: string;
  readonly userConfig: UserConfig;
  readonly runtime?: 'claude' | 'pi';
}
export interface ExplainLaunchSelectionRequest {
  readonly cwd: string;
  readonly userConfig: UserConfig;
  readonly identity?: string;
  readonly alias?: ShortLaunchAlias;
  readonly mode?: string;
  readonly executor?: 'host' | 'docker';
  readonly workspace?: 'clone' | 'host-worktree' | 'direct';
  readonly networkPolicy?: string;
  readonly preset?: string;
}
export interface PublicLaunchSelection {
  readonly mode: { readonly name: string };
  readonly selection: LaunchSelection['selection'];
  readonly executor: 'host' | 'docker';
  readonly workspace: 'clone' | 'host-worktree' | 'direct';
  readonly networkPolicy: { readonly name: string };
  readonly preset: string | null;
  readonly provenance: LaunchSelection['provenance'];
  readonly cwdClassification: LaunchSelection['cwdClassification'];
}
export function serializeLaunchSelection(selection: LaunchSelection): PublicLaunchSelection {
  return {
    mode: { name: selection.mode.name },
    selection: selection.selection,
    executor: selection.executor,
    workspace: selection.workspace,
    networkPolicy: { name: selection.networkPolicy.name },
    preset: selection.preset,
    provenance: selection.provenance,
    cwdClassification: selection.cwdClassification,
  };
}

interface PreparedFacts {
  readonly request: LaunchApplicationRequest;
  readonly found?: DiscoveredConfig;
  readonly projectId?: string;
  readonly repositoryId: string;
  readonly selection: LaunchSelection;
  readonly catalog: readonly CatalogSkill[];
  readonly manifest: ResolvedManifest;
  readonly artifact: RuntimeSkillArtifact;
  readonly skillArtifact: Awaited<ReturnType<typeof resolveLaunchSkills>>['skillArtifact'];
  readonly statusSnapshot: () => Promise<StatusSnapshot>;
  readonly warnings: readonly Diagnostic[];
}
interface ResolvedFacts extends PreparedFacts {
  readonly descriptor: LaunchDescriptor;
  readonly preparedExecutor?: PreparedLaunchExecutor;
}
declare const preparedBrand: unique symbol;
declare const resolvedBrand: unique symbol;
export interface PreparedLaunch {
  readonly [preparedBrand]: true;
}
export interface ResolvedApplicationLaunch {
  readonly [resolvedBrand]: true;
}

export interface LaunchExecutionInput {
  readonly descriptor: LaunchDescriptor;
  readonly manifest: ResolvedManifest;
  readonly artifact: RuntimeSkillArtifact;
  readonly catalog: readonly CatalogSkill[];
  readonly canonicalRoot: string;
  readonly cwd: string;
  readonly nativeRuntimeRoot: string;
  readonly statusSnapshot: () => Promise<StatusSnapshot>;
  readonly project?: DiscoveredConfig;
  readonly beforeChildExecution?: () => Promise<void>;
}
export interface PreparedLaunchExecutor {
  readonly assertReady: () => Promise<void>;
  readonly execute: (input: LaunchExecutionInput) => Promise<{ readonly exitCode: number }>;
}

export interface PiPreflightResult {
  readonly beforeChildExecution: () => Promise<void>;
}

export interface LaunchApplicationDependencies {
  discoverProjectConfig(cwd: string): Promise<DiscoveredConfig | undefined>;
  inventoryCanonical(root: string): Promise<readonly CanonicalSkill[]>;
  inventoryProjectSkills(
    root: string,
    canonical: readonly CanonicalSkill[],
  ): Promise<{
    readonly skills: readonly ProjectSkill[];
    readonly diagnostics: readonly { code: string; message: string; path?: string }[];
  }>;
  statusSnapshot(input: {
    readonly cwd: string;
    readonly projectRoot: string;
    readonly config: DiscoveredConfig['config'];
  }): Promise<StatusSnapshot>;
  prepareExecutor?(executor: 'host' | 'docker'): Promise<PreparedLaunchExecutor>;
  approveHost?(selection: Readonly<LaunchSelection>): Promise<HostApproval>;
  piPreflight?(input: {
    readonly runtimeRoot: string;
    readonly identity: LaunchSelection['identity'];
  }): Promise<void | (() => Promise<void>) | PiPreflightResult>;
  launchExecution?(input: LaunchExecutionInput): Promise<{ readonly exitCode: number }>;
}
export interface ResolvePreparedLaunchInput {
  readonly reason?: string;
  readonly hostApproval?: HostApproval;
}

const invalidState = () =>
  new MpxError({
    code: 'LAUNCH_STATE_INVALID',
    message: 'Launch application state is invalid or belongs to another service.',
  });
const freezeToken = <T>(): T => Object.freeze(Object.create(null)) as T;
const fallbackWarning = (): Diagnostic => ({
  code: 'PROJECT_CONFIG_MISSING_DEVELOPER_FALLBACK',
  severity: 'warning',
  message: 'Project configuration is missing; developer mode was selected automatically.',
});

export class LaunchApplicationService {
  readonly #prepared = new WeakMap<object, PreparedFacts>();
  readonly #resolved = new WeakMap<object, ResolvedFacts>();
  constructor(private readonly dependencies: LaunchApplicationDependencies) {}

  async explainSelection(request: ExplainLaunchSelectionRequest): Promise<{
    readonly data: {
      readonly schemaVersion: 1;
      readonly runtime: null;
      readonly identity: LaunchSelection['identity'];
      readonly selection: PublicLaunchSelection;
    };
    readonly warnings: readonly Diagnostic[];
  }> {
    const found = await this.dependencies.discoverProjectConfig(request.cwd);
    const projectId = found?.config.project.id;
    const selection = await resolveLaunchSelection({
      userConfig: request.userConfig,
      cwd: request.cwd,
      runtime: 'pi',
      ...(request.identity ? { identity: request.identity } : {}),
      ...(request.alias ? { alias: request.alias } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.executor ? { executor: request.executor } : {}),
      ...(request.workspace ? { workspace: request.workspace } : {}),
      ...(request.networkPolicy ? { networkPolicy: request.networkPolicy } : {}),
      ...(request.preset ? { preset: request.preset } : {}),
      ...(found ? { projectConfig: found.config } : {}),
      ...(projectId ? { projectId } : {}),
      ...(!found ? { automaticModeFallback: 'missing-project-config' as const } : {}),
    });
    validateLaunchDomain(selection);
    const warnings = selection.provenance.mode === 'automatic-fallback' ? [fallbackWarning()] : [];
    return {
      data: {
        schemaVersion: 1,
        runtime: null,
        identity: selection.identity,
        selection: serializeLaunchSelection(selection),
      },
      warnings,
    };
  }

  async prepareCandidates(
    request: LaunchCandidateRequest,
  ): Promise<{ readonly data: unknown; readonly warnings: readonly Diagnostic[] }> {
    const found = await this.dependencies.discoverProjectConfig(request.cwd);
    const projectId = found?.config.project.id;
    const candidates = [];
    for (const identity of Object.keys(request.userConfig.identities).sort()) {
      const selection = await resolveLaunchSelection({
        userConfig: request.userConfig,
        cwd: request.cwd,
        runtime: request.runtime ?? 'pi',
        identity,
        ...(found ? { projectConfig: found.config } : {}),
        ...(projectId ? { projectId } : {}),
      });
      candidates.push({
        identity,
        ...serializeLaunchSelection(selection),
        identityDomainCompatible: selection.identity.domain === selection.cwdClassification.domain,
      });
    }
    return {
      data: { schemaVersion: 1, identity: null, runtime: request.runtime ?? null, candidates },
      warnings: [],
    };
  }

  async prepare(request: LaunchApplicationRequest): Promise<PreparedLaunch> {
    if (request.runtimeArgs !== undefined && request.operation !== 'launch') {
      throw new MpxError({
        code: 'RUNTIME_ARGS_SCOPE_INVALID',
        message: 'Runtime arguments are valid only for launch execution.',
      });
    }
    const runtimeArgs =
      request.runtimeArgs === undefined ? undefined : canonicalRuntimeArgs(request.runtimeArgs);
    const canonicalRequest: LaunchApplicationRequest = {
      ...request,
      ...(runtimeArgs && runtimeArgs.length > 0 ? { runtimeArgs } : {}),
    };
    const found = await this.dependencies.discoverProjectConfig(request.cwd);
    const projectId = found?.config.project.id;
    const repositoryId = projectId ?? 'unbound/runtime';
    const selectionInput: ResolveLaunchSelectionInput = {
      userConfig: request.userConfig,
      cwd: request.cwd,
      ...(request.runtime ? { runtime: request.runtime } : {}),
      ...(request.identity ? { identity: request.identity } : {}),
      ...(request.alias ? { alias: request.alias } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.executor ? { executor: request.executor } : {}),
      ...(request.workspace ? { workspace: request.workspace } : {}),
      ...(request.networkPolicy ? { networkPolicy: request.networkPolicy } : {}),
      ...(request.preset ? { preset: request.preset } : {}),
      ...(found ? { projectConfig: found.config } : {}),
      ...(projectId ? { projectId } : {}),
      ...(!found ? { automaticModeFallback: 'missing-project-config' } : {}),
    };
    const selection = await resolveLaunchSelection(selectionInput);
    const warnings = selection.provenance.mode === 'automatic-fallback' ? [fallbackWarning()] : [];
    if (runtimeArgs?.length && selection.executor === 'docker') {
      throw new MpxError({
        code: 'RUNTIME_ARGS_EXECUTOR_UNAVAILABLE',
        message: 'Explicit runtime arguments are unavailable for Docker execution.',
      });
    }
    if (request.operation === 'launch' && selection.executor === 'docker') {
      throw new MpxError({
        code: 'EXECUTOR_UNAVAILABLE',
        message: 'Docker execution is unavailable.',
        details: { executor: 'docker', hostFallback: false },
      });
    }
    const { catalog, manifest, artifact, skillArtifact } = await resolveLaunchSkills(
      {
        ...(found ? { project: found } : {}),
        canonicalRoot: request.catalogRoot,
        identity: selection.identity.name,
        selection: selection.selection,
        runtime: selection.runtime,
      },
      this.dependencies,
    );
    const statusSnapshot =
      found && found.config.project.kind !== 'directory'
        ? () =>
            this.dependencies.statusSnapshot({
              cwd: request.cwd,
              projectRoot: found.root,
              config: found.config,
            })
        : async () =>
            parseStatusSnapshot({
              schemaVersion: 1,
              project: { id: repositoryId, cwd: request.cwd },
              worktree: { id: null, path: null, role: null, branch: null },
              portResolution: 'missing',
              services: [],
              diagnostics: [],
            });
    const token = freezeToken<PreparedLaunch>();
    this.#prepared.set(token as object, {
      request: canonicalRequest,
      ...(found ? { found } : {}),
      ...(projectId ? { projectId } : {}),
      repositoryId,
      selection,
      catalog,
      manifest,
      artifact,
      skillArtifact,
      statusSnapshot,
      warnings,
    });
    return token;
  }

  selection(state: PreparedLaunch): Readonly<LaunchSelection> {
    const facts = this.#prepared.get(state as object);
    if (!facts) {
      throw invalidState();
    }
    return Object.freeze(structuredClone(facts.selection));
  }

  async resolve(
    state: PreparedLaunch,
    input: ResolvePreparedLaunchInput = {},
  ): Promise<ResolvedApplicationLaunch> {
    const facts = this.#prepared.get(state as object);
    if (!facts) {
      throw invalidState();
    }
    const readOnly = facts.request.operation !== 'launch';
    const preparedExecutor = readOnly
      ? undefined
      : await this.dependencies.prepareExecutor?.(facts.selection.executor);
    if (preparedExecutor) {
      await preparedExecutor.assertReady();
    }
    const hostApproval =
      input.hostApproval ??
      (!readOnly && facts.selection.executor === 'host'
        ? await this.dependencies.approveHost?.(this.selection(state))
        : undefined);
    const descriptor = await resolveLaunch({
      userConfig: facts.request.userConfig,
      cwd: facts.request.cwd,
      runtime: facts.selection.runtime,
      identity: facts.selection.identity.name,
      ...(facts.found ? { projectConfig: facts.found.config } : {}),
      ...(facts.request.alias ? { alias: facts.request.alias } : {}),
      ...(facts.selection.provenance.mode !== 'automatic-fallback' && facts.request.mode
        ? { mode: facts.request.mode }
        : {}),
      executor: facts.selection.executor,
      workspace: facts.selection.workspace,
      networkPolicy: facts.selection.networkPolicy.name,
      ...(facts.request.preset ? { preset: facts.request.preset } : {}),
      ...(facts.selection.provenance.mode === 'automatic-fallback'
        ? { automaticModeFallback: 'missing-project-config' as const }
        : {}),
      ...(facts.request.runtimeArgs ? { runtimeArgs: facts.request.runtimeArgs } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(hostApproval ? { hostApproval } : {}),
      skillArtifact: facts.skillArtifact,
      selectedNativeRuntimeRoot:
        facts.request.userConfig.identities[facts.selection.identity.name]!.runtimeRoots[
          facts.selection.runtime
        ],
      ...(facts.projectId ? { projectId: facts.projectId } : {}),
      repositoryId: facts.repositoryId,
      policyInputs: {
        schemaVersion: 1,
        manifestKey: facts.manifest.manifestKey,
        skillArtifactKey: facts.skillArtifact.artifactKey,
      },
    });
    const token = freezeToken<ResolvedApplicationLaunch>();
    this.#resolved.set(token as object, {
      ...facts,
      descriptor,
      ...(preparedExecutor ? { preparedExecutor } : {}),
    });
    return token;
  }

  descriptor(state: ResolvedApplicationLaunch): LaunchDescriptor {
    const facts = this.#resolved.get(state as object);
    if (!facts) {
      throw invalidState();
    }
    return serializeLaunchPublic(facts.descriptor);
  }

  async execute(state: ResolvedApplicationLaunch): Promise<{
    readonly data: unknown;
    readonly warnings: readonly Diagnostic[];
    readonly silent?: boolean;
    readonly exitCode?: number;
  }> {
    const facts = this.#resolved.get(state as object);
    if (!facts) {
      throw invalidState();
    }
    if (facts.request.operation === 'explain') {
      return { data: serializeLaunchPublic(facts.descriptor), warnings: facts.warnings };
    }
    let beforeChildExecution: (() => Promise<void>) | undefined;
    if (facts.selection.runtime === 'pi') {
      const result = await this.dependencies.piPreflight?.({
        runtimeRoot:
          facts.request.userConfig.identities[facts.selection.identity.name]!.runtimeRoots.pi,
        identity: facts.selection.identity,
      });
      if (typeof result === 'function') {
        beforeChildExecution = result;
      } else if (result) {
        beforeChildExecution = result.beforeChildExecution;
      }
    }
    const execute = facts.preparedExecutor?.execute ?? this.dependencies.launchExecution;
    if (!execute) {
      throw new MpxError({
        code: 'LAUNCH_EXECUTION_UNAVAILABLE',
        message: 'Launch execution is unavailable.',
      });
    }
    const result = await execute({
      descriptor: facts.descriptor,
      manifest: facts.manifest,
      artifact: facts.artifact,
      catalog: facts.catalog,
      canonicalRoot: facts.request.catalogRoot,
      cwd: facts.request.cwd,
      nativeRuntimeRoot:
        facts.request.userConfig.identities[facts.selection.identity.name]!.runtimeRoots[
          facts.selection.runtime
        ],
      statusSnapshot: facts.statusSnapshot,
      ...(facts.found ? { project: facts.found } : {}),
      ...(beforeChildExecution ? { beforeChildExecution } : {}),
    });
    return { data: null, warnings: facts.warnings, silent: true, exitCode: result.exitCode };
  }
}
