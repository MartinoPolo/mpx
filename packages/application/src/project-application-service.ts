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
  type CanonicalSkill,
  type ProjectSkill,
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
  confirmInit?: typeof confirmInit;
  rollbackConfirmedInit?: typeof rollbackConfirmedInit;
  ensureProject?(request: {
    cwd: string;
    projectRoot: string;
    config: ProjectConfig;
    configHash: string;
  }): Promise<ProjectEnsureResult>;
}
export type ConfigurationKind = 'identity' | 'mode' | 'skill-policy' | 'preset';
export type ConfigurationAction = 'list' | 'show';

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
  // fallow-ignore-next-line unused-class-member -- public application API invoked through package consumers.
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
  // fallow-ignore-next-line unused-class-member -- public application API invoked through package consumers.
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
  configurationItem(request: {
    kind: ConfigurationKind;
    action: ConfigurationAction;
    user: UserConfig;
    name?: string;
  }): ApplicationOperationResult<unknown> {
    const source =
      request.kind === 'identity'
        ? request.user.identities
        : request.kind === 'mode'
          ? request.user.modes
          : request.kind === 'skill-policy'
            ? request.user.skillPolicies
            : request.user.presets;
    const publicItem = (name: string, value: unknown): unknown => {
      if (request.kind !== 'identity') {
        return { name, ...(value as Record<string, unknown>) };
      }
      const identity = value as UserConfig['identities'][string];
      return {
        name,
        domain: identity.domain,
        gitAuthorRoute: identity.gitAuthorRoute,
        providerRoutes: Object.fromEntries(
          Object.entries(identity.providerRoutes ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ),
        sshRoute: identity.sshRoute ?? null,
        mcpSharing: {
          allow: [...(identity.mcpSharing?.allow ?? [])].sort(),
          shareNativeAuth: false,
        },
      };
    };
    if (request.action === 'list') {
      return {
        data: {
          schemaVersion: 1,
          kind: request.kind,
          items: Object.entries(source)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => publicItem(name, value)),
        },
      };
    }
    const value = request.name === undefined ? undefined : source[request.name];
    if (!value) {
      throw new MpxError({
        code: `${request.kind.replace('-', '_').toUpperCase()}_UNKNOWN`,
        message: `Unknown ${request.kind} '${request.name}'.`,
      });
    }
    return {
      data: { schemaVersion: 1, kind: request.kind, item: publicItem(request.name!, value) },
    };
  }
  // fallow-ignore-next-line unused-class-member -- public application API invoked through package consumers.
  async config(
    request:
      | { cwd: string; action: 'show' }
      | { cwd: string; action: 'validate' }
      | { cwd: string; action: 'resolve'; user: UserConfig }
      | { cwd: string; action: 'explain'; user: UserConfig },
  ): Promise<ApplicationOperationResult<unknown>> {
    const found = await this.discover(request.cwd);
    if (request.action === 'show') {
      return { data: { path: found.path, config: found.config } };
    }
    if (request.action === 'validate') {
      return { data: { valid: true, path: found.path } };
    }
    const resolved = await (this.dependencies.resolveConfig ?? resolveConfig)(
      found.config,
      request.user,
      request.cwd,
    );
    return { data: request.action === 'explain' ? { provenance: resolved.provenance } : resolved };
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
    user: UserConfig;
    canonical: readonly CanonicalSkill[];
    projectInventory: {
      skills: ProjectSkill[];
      diagnostics: { code: string; message: string; path?: string }[];
    };
    additionalDiagnostics?: readonly Diagnostic[];
  }): Promise<
    ApplicationOperationResult<{
      diagnostics: Diagnostic[];
      cwdClassification: ResolvedConfig['cwdClassification'];
      resolvedContentScope: string;
    }>
  > {
    const found = await this.discover(request.cwd);
    const resolved = await (this.dependencies.resolveConfig ?? resolveConfig)(
      found.config,
      request.user,
      request.cwd,
    );
    const diagnostics: Diagnostic[] = [
      ...(this.dependencies.configDoctor ?? configDoctor)(found.config, request.user).map(
        ({ code, message, severity, pointer }: ConfigDiagnostic) => ({
          code,
          message,
          severity,
          ...(pointer ? { details: { pointer } } : {}),
        }),
      ),
      ...(this.dependencies.skillDoctor ?? skillDoctor)(
        request.canonical,
        request.projectInventory,
      ).map(({ code, message, path }) => ({
        code,
        message,
        severity: 'error' as const,
        ...(path ? { details: { path } } : {}),
      })),
      ...(request.additionalDiagnostics ?? []),
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
