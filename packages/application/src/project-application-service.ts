import {
  ConfigValidationError,
  StrictJsonError,
  confirmInit,
  discoverProjectConfig,
  doctor as configDoctor,
  loadUserConfig,
  planInit,
  resolveConfig,
  resolveEffectiveSkillPacks,
  rollbackConfirmedInit,
  type Diagnostic as ConfigDiagnostic,
  type DiscoveredConfig,
  type ProjectConfig,
  type ResolvedConfig,
  type UserConfig,
} from '@mpx/config';
import { MpxError, sha256Canonical, type Diagnostic, type JsonValue } from '@mpx/core';
import {
  doctor as skillDoctor,
  inventoryCanonical,
  inventoryProjectSkills,
  type ResolveOptions,
} from '@mpx/skills';
import type { ApplicationOperationResult } from './contracts.js';

export interface ProjectPathOperations {
  join(...parts: string[]): string;
  basename(value: string): string;
  isAbsolute(value: string): boolean;
}
export interface ProjectEnsureResult {
  readonly lease: unknown;
  readonly warnings: readonly { code: string; message: string; port?: number }[];
}
export interface ProjectApplicationDependencies {
  readonly path: ProjectPathOperations;
  access(file: string): Promise<void>;
  discoverProjectConfig?: typeof discoverProjectConfig;
  loadUserConfig?: typeof loadUserConfig;
  resolveConfig?: typeof resolveConfig;
  configDoctor?: typeof configDoctor;
  skillDoctor?: typeof skillDoctor;
  catalogRoot?(cwd: string): Promise<string>;
  inventoryCanonical?: typeof inventoryCanonical;
  inventoryProjectSkills?: typeof inventoryProjectSkills;
  sbxDiagnostics?(request: { cwd: string }): Promise<{
    readonly available: boolean;
    readonly failureCodes: readonly string[];
    readonly readOnly: boolean;
  }>;
  sbxProofDiagnostics?(): Promise<readonly string[]>;
  statusSnapshot?(request: {
    cwd: string;
    projectRoot: string;
    config: ProjectConfig;
    configHash: string;
  }): Promise<{
    readonly diagnostics: readonly {
      code: string;
      message: string;
      severity: Diagnostic['severity'];
      serviceId?: string | null;
    }[];
  }>;
  confirmInit?: typeof confirmInit;
  rollbackConfirmedInit?: typeof rollbackConfirmedInit;
  providerDiagnostics?(request: {
    cwd: string;
    project: ProjectConfig;
    user: UserConfig;
  }): Promise<readonly Diagnostic[]>;
  ensureProject?(request: {
    cwd: string;
    projectRoot: string;
    config: ProjectConfig;
    configHash: string;
  }): Promise<ProjectEnsureResult>;
}
const emptyUserConfig = (): UserConfig => ({
  identities: {},
  domains: {},
  contentScopes: {},
  modes: {},
  skillPolicies: {},
  presets: {},
  launchDefaults: { projects: {}, scopes: {} },
  networkPolicies: {},
  executors: { host: {} },
});
const stableCode = (error: unknown): string =>
  error instanceof MpxError ? error.code : 'COMMAND_FAILED';
const unreadable = (error: unknown): MpxError => {
  const candidate =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return new MpxError({
    code: 'USER_CONFIG_UNREADABLE',
    message: 'User configuration could not be read.',
    details: { errno: typeof candidate === 'string' && candidate ? candidate : 'UNKNOWN' },
  });
};
const requiredError = (absolute: boolean): MpxError =>
  new MpxError({
    code: 'USER_CONFIG_REQUIRED',
    message: 'Launch-bound commands require strict user-local configuration.',
    remediation: absolute
      ? 'Create %APPDATA%/mpx/config.json.'
      : 'Create %APPDATA%/mpx/config.json and set APPDATA to an absolute path.',
  });

export function resolveProjectSkillOptions(
  user: UserConfig,
  binding: {
    identity: string;
    skillPolicy: string;
    contentScope: string;
    repositoryId: string;
    projectId?: string;
  },
): ResolveOptions {
  const configuredScope = user.contentScopes[binding.contentScope];
  if (!configuredScope) {
    throw new MpxError({
      code: 'CONTENT_SCOPE_UNKNOWN',
      message: `Unknown content scope '${binding.contentScope}'.`,
    });
  }
  const policy = user.skillPolicies[binding.skillPolicy];
  if (!policy) {
    throw new MpxError({
      code: 'SKILL_POLICY_UNKNOWN',
      message: `Unknown skill policy '${binding.skillPolicy}'.`,
    });
  }
  const override = binding.projectId ? user.projects?.[binding.projectId] : undefined;
  return {
    repositoryId: binding.repositoryId,
    contentScope: binding.contentScope,
    ...(binding.projectId ? { projectId: binding.projectId } : {}),
    enabledPacks: resolveEffectiveSkillPacks({
      contentScopeSkillPacks: configuredScope.skillPacks,
      projectSkillPacks: override?.skillPacks,
      skillPolicySkillPacks: policy.skillPacks,
    }),
    identity: binding.identity,
    skillPolicy: binding.skillPolicy,
    skillPolicyConfig: policy,
    contentScopeExposure: configuredScope.skillExposure ?? {},
    ...(override?.skillExposure ? { projectExposure: override.skillExposure } : {}),
  };
}

export class ProjectApplicationService {
  constructor(private readonly dependencies: ProjectApplicationDependencies) {}

  async discover(cwd: string): Promise<DiscoveredConfig> {
    const found = await (this.dependencies.discoverProjectConfig ?? discoverProjectConfig)(cwd);
    if (!found) {
      throw new MpxError({
        code: 'CONFIG_NOT_FOUND',
        message: 'No mpxconfig.json was found.',
        remediation: "Run 'mpx init' in the project root.",
      });
    }
    return found;
  }
  private async present(file: string): Promise<boolean> {
    try {
      await this.dependencies.access(file);
      return true;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return false;
      }
      throw unreadable(error);
    }
  }
  private async read(
    file: string,
    environment: Record<string, string | undefined>,
  ): Promise<UserConfig> {
    try {
      return await (this.dependencies.loadUserConfig ?? loadUserConfig)(file, environment);
    } catch (error) {
      if (
        error instanceof StrictJsonError ||
        error instanceof ConfigValidationError ||
        error instanceof MpxError
      ) {
        throw error;
      }
      throw unreadable(error);
    }
  }
  async optionalUserConfig(request: {
    appdata?: string;
    environment: Record<string, string | undefined>;
  }): Promise<UserConfig> {
    if (!request.appdata) {
      return emptyUserConfig();
    }
    const file = this.dependencies.path.join(request.appdata, 'mpx', 'config.json');
    return (await this.present(file)) ? this.read(file, request.environment) : emptyUserConfig();
  }
  async requiredUserConfig(request: {
    appdata?: string;
    environment: Record<string, string | undefined>;
  }): Promise<UserConfig> {
    if (!request.appdata || !this.dependencies.path.isAbsolute(request.appdata)) {
      throw requiredError(false);
    }
    const file = this.dependencies.path.join(request.appdata, 'mpx', 'config.json');
    if (!(await this.present(file))) {
      throw requiredError(true);
    }
    return this.read(file, request.environment);
  }
  // fallow-ignore-next-line unused-class-member -- public application API invoked through package consumers.
  async init(request: {
    cwd: string;
    confirm: boolean;
  }): Promise<ApplicationOperationResult<unknown> & { warnings?: readonly Diagnostic[] }> {
    const existing = await (this.dependencies.discoverProjectConfig ?? discoverProjectConfig)(
      request.cwd,
    );
    const suggestedManifest: ProjectConfig = {
      schemaVersion: 1,
      project: { id: `REPLACE_ME/${this.dependencies.path.basename(request.cwd)}` },
      repository: { provider: 'generic', remote: 'REPLACE_ME' },
    };
    const plan = planInit(request.cwd, Boolean(existing));
    if (!request.confirm) {
      return { data: { plan, suggestedManifest } };
    }
    if (!this.dependencies.ensureProject) {
      throw new MpxError({
        code: 'INIT_PUBLICATION_UNAVAILABLE',
        message: 'Init publication is unavailable.',
      });
    }
    const confirmation = await (this.dependencies.confirmInit ?? confirmInit)(
      request.cwd,
      Boolean(existing),
      suggestedManifest,
    );
    const found = existing ?? (await this.discover(request.cwd));
    let result: ProjectEnsureResult;
    try {
      result = await this.dependencies.ensureProject({
        cwd: request.cwd,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      });
    } catch (error) {
      let rollbackError: unknown;
      try {
        await (this.dependencies.rollbackConfirmedInit ?? rollbackConfirmedInit)(confirmation);
      } catch (caught) {
        rollbackError = caught;
      }
      const details =
        error instanceof MpxError &&
        error.details &&
        typeof error.details === 'object' &&
        !Array.isArray(error.details)
          ? (error.details as Record<string, unknown>)
          : {};
      const portCompensation =
        error instanceof MpxError && error.code === 'PORT_ENSURE_COMPENSATION_FAILED';
      if (portCompensation || rollbackError) {
        throw new MpxError({
          code: portCompensation ? 'INIT_COMPENSATION_FAILED' : 'INIT_ROLLBACK_FAILED',
          message: portCompensation
            ? 'Init port publication failed and exact lease compensation could not be completed.'
            : 'Init failed and its owned manifest could not be rolled back safely.',
          remediation: 'Inspect the project init artifacts and port registry, then retry init.',
          details: {
            originalCode:
              typeof details.originalCode === 'string' ? details.originalCode : stableCode(error),
            ...(typeof details.compensationCode === 'string'
              ? { compensationCode: details.compensationCode }
              : {}),
            ...(rollbackError ? { rollbackCode: stableCode(rollbackError) } : {}),
          },
        });
      }
      throw error;
    }
    const warnings: Diagnostic[] = [
      ...(confirmation.pendingTemporaryPath
        ? [
            {
              code: 'INIT_TEMP_CLEANUP_PENDING',
              message: 'Init completed, but owned temporary-file cleanup is pending.',
              severity: 'warning' as const,
            },
          ]
        : []),
      ...result.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        severity: 'warning' as const,
        ...(warning.port === undefined ? {} : { details: { port: warning.port } }),
      })),
    ];
    return { data: { plan, suggestedManifest, confirmed: true, lease: result.lease }, warnings };
  }
  // fallow-ignore-next-line unused-class-member -- public application API invoked through package consumers.
  async doctor(request: {
    cwd: string;
    appdata?: string;
    environment: Record<string, string | undefined>;
    catalogRoot?: string;
  }): Promise<
    ApplicationOperationResult<{
      diagnostics: Diagnostic[];
      cwdClassification: ResolvedConfig['cwdClassification'];
      resolvedContentScope: string;
    }>
  > {
    const found = await this.discover(request.cwd);
    const user = await this.optionalUserConfig({
      ...(request.appdata ? { appdata: request.appdata } : {}),
      environment: request.environment,
    });
    const catalogRoot = request.catalogRoot ?? (await this.dependencies.catalogRoot?.(request.cwd));
    if (!catalogRoot) {
      throw new MpxError({
        code: 'SKILL_CATALOG_UNAVAILABLE',
        message: 'Canonical skill catalog was not found.',
      });
    }
    const canonical = await (this.dependencies.inventoryCanonical ?? inventoryCanonical)(
      catalogRoot,
    );
    const projectInventory = await (
      this.dependencies.inventoryProjectSkills ?? inventoryProjectSkills
    )(found.root, canonical);
    const additionalDiagnostics: Diagnostic[] = [];
    if (this.dependencies.sbxDiagnostics) {
      const sbx = await this.dependencies.sbxDiagnostics({ cwd: request.cwd });
      if (!sbx.readOnly) {
        throw new MpxError({
          code: 'SBX_DIAGNOSTICS_UNSAFE',
          message: 'Sandbox diagnostics must be read-only.',
        });
      }
      for (const code of [...new Set(sbx.failureCodes)].sort()) {
        additionalDiagnostics.push({
          code,
          message: `Standalone sbx diagnostic: ${code}.`,
          severity: 'warning',
          details: { executor: 'docker' },
        });
      }
      for (const code of (await this.dependencies.sbxProofDiagnostics?.()) ?? []) {
        additionalDiagnostics.push({
          code,
          message: `Standalone sbx proof diagnostic: ${code}.`,
          severity: 'warning',
          details: { executor: 'docker' },
        });
      }
    }
    additionalDiagnostics.push(
      ...((await this.dependencies.providerDiagnostics?.({
        cwd: request.cwd,
        project: found.config,
        user,
      })) ?? []),
    );
    const services = Object.entries(found.config.development?.services ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [name, service] of services) {
      if (service.port.mode === 'fixed-shared') {
        additionalDiagnostics.push({
          code: 'FIXED_SHARED_LIMITATION',
          message: `Service ${name} uses a fixed-shared port that MPX cannot reserve exclusively.`,
          severity: 'warning',
          details: {
            service: name,
            ...(service.port.preferred === undefined ? {} : { port: service.port.preferred }),
          },
        });
      }
    }
    if (
      this.dependencies.statusSnapshot &&
      services.some(([, service]) => service.port.mode === 'managed')
    ) {
      const snapshot = await this.dependencies.statusSnapshot({
        cwd: request.cwd,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      });
      additionalDiagnostics.push(
        ...snapshot.diagnostics.map(({ code, message, severity, serviceId }) => ({
          code,
          message,
          severity,
          ...(serviceId ? { details: { service: serviceId } } : {}),
        })),
      );
    }
    const resolved = await (this.dependencies.resolveConfig ?? resolveConfig)(
      found.config,
      user,
      request.cwd,
    );
    const diagnostics: Diagnostic[] = [
      ...(this.dependencies.configDoctor ?? configDoctor)(found.config, user).map(
        ({ code, message, severity, pointer }: ConfigDiagnostic) => ({
          code,
          message,
          severity,
          ...(pointer ? { details: { pointer } } : {}),
        }),
      ),
      ...(this.dependencies.skillDoctor ?? skillDoctor)(canonical, projectInventory).map(
        ({ code, message, path }) => ({
          code,
          message,
          severity: 'error' as const,
          ...(path ? { details: { path } } : {}),
        }),
      ),
      ...additionalDiagnostics,
    ];
    return {
      data: {
        diagnostics,
        cwdClassification: resolved.cwdClassification,
        resolvedContentScope: resolved.contentScope.name,
      },
      exitCode: diagnostics.some((item) => item.severity === 'error') ? 1 : 0,
    };
  }
}
export const createProjectApplicationService = (
  dependencies: ProjectApplicationDependencies,
): ProjectApplicationService => new ProjectApplicationService(dependencies);
