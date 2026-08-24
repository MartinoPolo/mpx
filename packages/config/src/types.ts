export type RepositoryProvider = "github" | "gitlab" | "gerrit" | "generic";
export type IssueProvider = "github" | "gitlab" | "kanbanflow" | "local" | "none";
export const SKILL_PACKS = ["core", "work", "personal"] as const;
export const EXPOSURES = ["full", "name-only", "explicit-only", "off"] as const;
export const MODE_RESOURCES = [
  "selected-project", "identity-domain", "cloned-repositories", "assistant-input", "assistant-output",
  "computer-control-config", "computer-control-executable-settings", "host",
] as const;
export const RESOURCE_ACCESS = ["read-only", "read-write", "staged-write"] as const;
export type SkillPack = (typeof SKILL_PACKS)[number];
export type Exposure = (typeof EXPOSURES)[number];
export type ModeResource = (typeof MODE_RESOURCES)[number];
export type ResourceAccess = (typeof RESOURCE_ACCESS)[number];
export type Runtime = "claude" | "pi";
export type Executor = "host" | "docker";
export type WorkspaceStrategy = "clone" | "host-worktree" | "direct";
export type NetworkPolicyPreset = "allow-all" | "balanced" | "deny-all";
export interface IssueStates { todo: string; wip: string; review: string; done: string; archive?: string }
export type IssuesConfig = { provider: "github" | "gitlab" | "local" | "none" } | { provider: "kanbanflow"; boardId: string; boardName?: string; states: IssueStates };
export interface PreparationStepBase { id: string; dependsOn?: string[]; required?: boolean; timeoutSeconds?: number; cwd?: string; environment?: string[] }
export type PreparationStep =
  | (PreparationStepBase & { uses: "package-install" })
  | (PreparationStepBase & { uses: "package-script"; script: string })
  | (PreparationStepBase & { uses: "executable"; argv: string[] });
export interface PreparationPlan {
  execution: "foreground" | "background" | "none";
  steps: readonly (PreparationStep & { required: boolean })[];
  order: readonly string[];
  logging: { readonly maxOutputBytes: 65536; readonly redactEnvironmentValues: true };
}
export interface ServiceConfig { scope: "checkout" | "project"; port: { mode: "managed" | "fixed-shared"; preferred?: number; family?: string }; environmentVariable?: string; protocol?: "http" | "https" | "tcp"; start: { type: "package-script"; script: string } }
export interface ProjectConfig { $schema?: string; schemaVersion: 1; project: { id: string }; repository: { provider: RepositoryProvider; remote: string }; issues?: IssuesConfig; tooling?: { packageManager: "auto"|"pnpm"|"yarn"|"npm"|"bun"|"none" }; workflow?: { branch?: { base?: string; template?: string }; codeReview?: { openAsDraft?: boolean; markReady?: "human"|"agent"; merge?: "human"|"agent" } }; worktrees?: { postCreate?: { execution: "foreground"|"background"|"none"; steps?: PreparationStep[] } }; development?: { services: Record<string, ServiceConfig> } }
export interface ExposureConfig { default?: Exposure; skills?: Record<string, Exposure> }
export interface ContentScope { roots: string[]; skillPacks?: SkillPack[]; skillExposure?: ExposureConfig }
export interface ProjectOverride { skillPacks?: SkillPack[]; skillExposure?: ExposureConfig }
export interface IdentityConfig {
  domain: string;
  runtimeRoots: Record<Runtime, string>;
  gitAuthorRoute: string;
  providerRoutes?: Record<string, string>;
  sshRoute?: string;
  mcpSharing?: { allow: string[]; shareNativeAuth: false };
}
export interface ModeConfig { resources: Partial<Record<ModeResource, ResourceAccess>> }
export interface SkillPolicyConfig { skillPacks?: SkillPack[]; skillExposure: ExposureConfig & { default: Exposure } }
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
  skillPolicy: string;
  contentScope: string;
  executor: Executor;
  workspace: WorkspaceStrategy;
  networkPolicy: string;
}
export type IdentityPresetDefaults = Record<string, string>;
export interface LaunchDefaultsConfig {
  scopes: Record<string, IdentityPresetDefaults>;
  projects: Record<string, IdentityPresetDefaults>;
}
export interface UserConfig {
  identities: Record<string, IdentityConfig>;
  domains: Record<string, string[]>;
  contentScopes: Record<string, ContentScope>;
  modes: Record<string, ModeConfig>;
  skillPolicies: Record<string, SkillPolicyConfig>;
  presets: Record<string, PresetConfig>;
  launchDefaults: LaunchDefaultsConfig;
  networkPolicies: Record<string, NetworkPolicyConfig>;
  executors: Partial<Record<Executor, Record<string, never>>>;
  projects?: Record<string, ProjectOverride>;
}
export type CwdClassification = { status: "known"; domain: string; root: string } | { status: "unknown" };
export type ContentScopeClassification = { status: "known"; contentScope: string; root: string } | { status: "unknown" };
export interface ProvenanceEntry { pointer: string; source: "default"|"project"|"user-content-scope"|"user-project"|"runtime" }
export interface ResolvedConfig { project: ProjectConfig; cwdClassification: CwdClassification & { status: "known" }; contentScope: { name: string; root: string; skillPacks: SkillPack[]; skillExposure: ExposureConfig; projectSkillExposure?: ExposureConfig }; provenance: ProvenanceEntry[] }
export interface Diagnostic { code: string; severity: "error"|"warning"|"info"; message: string; pointer?: string; remediation?: string }
