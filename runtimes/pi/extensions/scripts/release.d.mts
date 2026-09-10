// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export const HOST_EXTERNALS: readonly string[];
// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export const GUARD_ASSETS: readonly string[];
// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export const CONFIG_ASSETS: readonly string[];
// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export const CONFIG_SCHEMA_ASSETS: readonly string[];
// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export const VENDORED_LICENSE_ASSETS: readonly string[];
// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export const PACKAGE_ASSETS: readonly string[];

interface EntryStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface WalkOperations {
  readdir(directory: string): Promise<string[]>;
  lstat(path: string): Promise<EntryStat>;
}

interface WalkOptions {
  currentPrefix?: string;
  ignoredTopLevelDirectories?: ReadonlySet<string>;
  inspectPath?: (relativePath: string) => void;
  operations?: WalkOperations;
}

interface PublishOperations {
  renamePath?: (source: string, destination: string) => Promise<void>;
  removePath?: (path: string, options: { recursive: true; force: true }) => Promise<void>;
}

interface ImportSpecifierAnalysis {
  staticSpecifiers: string[];
  dynamicSpecifiers: string[];
}

// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export function assertAllowedImportSpecifiers(source: string): ImportSpecifierAnalysis;
// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export function walkRegularFiles(directory: string, options?: WalkOptions): Promise<string[]>;
// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export function publishArtifact(
  staging: string,
  target: string,
  backup: string,
  operations?: PublishOperations,
): Promise<void>;
// fallow-ignore-next-line unused-export -- declaration companion for the dynamically loaded release API.
export function buildRelease(): Promise<void>;
// fallow-ignore-next-line unused-export -- declaration companion for the release test API.
export function verifyRelease(): Promise<void>;
