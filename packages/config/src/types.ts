export type RepositoryProvider = "github" | "gitlab" | "gerrit" | "generic";
export type IssueProvider = "github" | "gitlab" | "kanbanflow" | "local" | "none";
export const SKILL_PACKS = ["core", "work", "personal"] as const;
export const EXPOSURES = ["full", "name-only", "explicit-only", "off"] as const;
export type SkillPack = (typeof SKILL_PACKS)[number];
export type Exposure = (typeof EXPOSURES)[number];
export interface IssueStates { todo: string; wip: string; review: string; done: string; archive?: string }
export type IssuesConfig = { provider: "github" | "gitlab" | "local" | "none" } | { provider: "kanbanflow"; boardId: string; boardName?: string; states: IssueStates };
export interface PreparationStepBase { id: string; after?: string[]; required?: boolean; timeoutSeconds?: number; workingDirectory?: string; environment?: string[] }
export type PreparationStep = (PreparationStepBase & { uses: "package-install" }) | (PreparationStepBase & { uses: "package-script"; script: string });
export interface ServiceConfig { scope: "checkout" | "project"; port: { mode: "managed" | "fixed-shared"; preferred?: number; family?: string }; environmentVariable?: string; protocol?: "http" | "https" | "tcp"; start: { type: "package-script"; script: string } }
export interface ProjectConfig { $schema?: string; schemaVersion: 1; project: { id: string }; repository: { provider: RepositoryProvider; remote: string }; issues?: IssuesConfig; tooling?: { packageManager: "auto"|"pnpm"|"yarn"|"npm"|"bun"|"none" }; workflow?: { branch?: { base?: string; template?: string }; codeReview?: { openAsDraft?: boolean; markReady?: "human"|"agent"; merge?: "human"|"agent" } }; worktrees?: { postCreate?: { execution: "foreground"|"background"|"none"; steps?: PreparationStep[] } }; development?: { services: Record<string, ServiceConfig> } }
export interface ExposureConfig { default?: Exposure; skills?: Record<string, Exposure> }
export interface UserScope { roots: string[]; skillPacks?: SkillPack[]; skillExposure?: ExposureConfig; connections?: Record<string,string> }
export interface ProjectOverride { skillPacks?: SkillPack[]; skillExposure?: ExposureConfig; connections?: Record<string,string> }
export interface UserConfig { scopes: Record<string,UserScope>; projects?: Record<string,ProjectOverride> }
export interface ProvenanceEntry { pointer: string; source: "default"|"project"|"user-scope"|"user-project"|"runtime" }
export interface ResolvedConfig { project: ProjectConfig; scope: { name: string; root?: string; skillPacks: SkillPack[]; skillExposure: ExposureConfig; projectSkillExposure?: ExposureConfig; connections: Record<string,string> }; provenance: ProvenanceEntry[] }
export interface Diagnostic { code: string; severity: "error"|"warning"|"info"; message: string; pointer?: string; remediation?: string }
