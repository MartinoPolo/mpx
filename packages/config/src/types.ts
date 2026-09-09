import type { ResolvedSkillSelection, SkillPack } from '@mpx/skills/contracts';

export {
  EXPOSURES,
  SKILL_PACKS,
  type Exposure,
  type ResolvedSkillSelection,
  type SkillPack,
} from '@mpx/skills/contracts';

export type RepositoryProvider = string;
export type IssueProvider = string;
export const MODE_RESOURCES = [
  'selected-project',
  'identity-domain',
  'cloned-repositories',
  'computer-control-config',
  'computer-control-executable-settings',
  'host',
] as const;
export const RESOURCE_ACCESS = ['read-only', 'read-write', 'staged-write'] as const;
export type ModeResource = (typeof MODE_RESOURCES)[number];
export type ResourceAccess = (typeof RESOURCE_ACCESS)[number];
export type Runtime = 'claude' | 'pi';
export type Executor = 'host' | 'docker';
export type WorkspaceStrategy = 'clone' | 'host-worktree' | 'direct';
export type NetworkPolicyPreset = 'allow-all' | 'balanced' | 'deny-all';
export interface IssueStates {
  todo: string;
  wip: string;
  review: string;
  done: string;
  archive?: string;
}
export interface IssuesConfig {
  provider: IssueProvider;
  store?: string;
  view?: string;
  boardId?: string;
  boardName?: string;
  states?: IssueStates;
}
export interface LocalIssueStoreRegistration {
  root: string;
}
export interface LocalViewRegistration {
  vaultRoot: string;
  outputRoot: string;
  vaultSubtree: string;
  resumeBaseUrl: string;
}
export interface PreparationStepBase {
  id: string;
  dependsOn?: string[];
  required?: boolean;
  timeoutSeconds?: number;
  cwd?: string;
  environment?: string[];
}
export type PreparationStep =
  | (PreparationStepBase & { uses: 'package-install' })
  | (PreparationStepBase & { uses: 'package-script'; script: string })
  | (PreparationStepBase & { uses: 'executable'; argv: string[] });
export interface PreparationPlan {
  execution: 'foreground' | 'background' | 'none';
  steps: readonly (PreparationStep & { required: boolean })[];
  order: readonly string[];
  logging: { readonly maxOutputBytes: 65536; readonly redactEnvironmentValues: true };
}
export type ServiceLauncher =
  | { type: 'package-script'; script: string }
  | { type: 'external'; kind: 'database' }
  | { type: 'test-only' };
export interface ServiceConfig {
  scope: 'checkout' | 'project';
  port: { mode: 'managed' | 'fixed-shared'; preferred?: number; family?: string };
  environmentVariable?: string;
  protocol?: 'http' | 'https' | 'tcp';
  start: ServiceLauncher;
}
export interface ProjectConfig {
  $schema?: string;
  schemaVersion: 1;
  project: { id: string; kind?: 'directory' };
  repository?: { provider: RepositoryProvider; remote: string };
  issues?: IssuesConfig;
  tooling?: { packageManager: 'auto' | 'pnpm' | 'yarn' | 'npm' | 'bun' | 'none' };
  workflow?: {
    branch?: { base?: string; template?: string };
    codeReview?: {
      openAsDraft?: boolean;
      markReady?: 'human' | 'agent';
      merge?: 'human' | 'agent';
    };
  };
  worktrees?: {
    postCreate?: { execution: 'foreground' | 'background' | 'none'; steps?: PreparationStep[] };
  };
  development?: { services: Record<string, ServiceConfig> };
  skills?: { packs: SkillPack[] };
}
export type DirectoryProjectConfig = ProjectConfig & {
  project: { id: string; kind: 'directory' };
  repository?: never;
};
export type RepositoryProjectConfig = ProjectConfig & {
  project: { id: string; kind?: never };
  repository: { provider: RepositoryProvider; remote: string };
};
export function isDirectoryProjectConfig(config: ProjectConfig): config is DirectoryProjectConfig {
  return config.project.kind === 'directory';
}
export function isRepositoryProjectConfig(
  config: ProjectConfig,
): config is RepositoryProjectConfig {
  return config.project.kind === undefined && config.repository !== undefined;
}
export interface LocationConfig {
  roots: string[];
  skillPacks: SkillPack[];
}
export interface ProjectOverride {
  skillPacks: SkillPack[];
}
export interface IdentityConfig {
  domain: string;
  runtimeRoots: Record<Runtime, string>;
  gitAuthorRoute: string;
  providerRoutes?: Record<string, string>;
  sshRoute?: string;
  mcpSharing?: { allow: string[]; shareNativeAuth: false };
  allowedSkillPacks: SkillPack[];
}
export interface ModeConfig {
  resources: Partial<Record<ModeResource, ResourceAccess>>;
}
export interface NetworkPolicyConfig {
  preset?: NetworkPolicyPreset;
  extends?: string;
  denyPrivateNetworks?: boolean;
  approvedProjectAdditions?: boolean;
  approvedDeliveryAdditions?: boolean;
  requiredRuntimeEndpoints?: boolean;
}
export interface PresetConfig {
  identity: string;
  mode: string;
  executor: Executor;
  workspace: WorkspaceStrategy;
  networkPolicy: string;
}
export type IdentityPresetDefaults = Record<string, string>;
export interface LaunchDefaultsConfig {
  locations: Record<string, IdentityPresetDefaults>;
  projects: Record<string, IdentityPresetDefaults>;
}
export type ConfigurableResource =
  'cloned-repositories' | 'computer-control-config' | 'computer-control-executable-settings';
export interface UserConfig {
  schemaVersion: 2;
  identities: Record<string, IdentityConfig>;
  domains: Record<string, string[]>;
  locations: Record<string, LocationConfig>;
  resourceRoots?: Partial<Record<ConfigurableResource, string[]>>;
  modes: Record<string, ModeConfig>;
  presets: Record<string, PresetConfig>;
  launchDefaults: LaunchDefaultsConfig;
  networkPolicies: Record<string, NetworkPolicyConfig>;
  executors: Partial<Record<Executor, Record<string, never>>>;
  projects?: Record<string, ProjectOverride>;
  localIssueStores?: Record<string, LocalIssueStoreRegistration>;
  localViews?: Record<string, LocalViewRegistration>;
}
export type CwdClassification =
  { status: 'known'; domain: string; root: string } | { status: 'unknown' };
export type LocationClassification =
  { status: 'known'; location: string; canonicalRoot: string } | { status: 'unknown' };
export type ApplicableResourceClassification =
  | { status: 'known'; resource: ConfigurableResource; canonicalRoot: string }
  | { status: 'unknown' };
export interface ProvenanceEntry {
  pointer: string;
  source: 'default' | 'project' | 'user-location' | 'user-project' | 'runtime';
}
export interface ResolvedConfig {
  project: ProjectConfig;
  cwdClassification: CwdClassification & { status: 'known' };
  selection: ResolvedSkillSelection;
  provenance: ProvenanceEntry[];
}
export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  pointer?: string;
  remediation?: string;
}
