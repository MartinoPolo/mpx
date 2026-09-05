export const HOST_EXTERNALS: readonly string[];
export const GUARD_ASSETS: readonly string[];
export const CONFIG_ASSETS: readonly string[];
export const THEME_ASSETS: readonly string[];
export const VENDORED_LICENSE_ASSETS: readonly string[];
export const PACKAGE_ASSETS: readonly string[];

export interface BundlerOptions {
  readonly bundle: true;
  readonly external: readonly string[];
  readonly format: 'esm';
  readonly legalComments: 'none';
  readonly minifyWhitespace: true;
  readonly platform: 'node';
  readonly sourcemap: false;
  readonly target: 'node22';
}

export interface BundlerConfig {
  readonly entryPoint: 'index.ts';
  readonly outputFile: 'index.mjs';
  readonly esbuildVersion: string;
  readonly options: BundlerOptions;
}

export const BUNDLER_OPTIONS: Readonly<BundlerOptions>;
export const BUNDLER_CONFIG: Readonly<BundlerConfig>;

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

export function analyzeImportSpecifiers(source: string): ImportSpecifierAnalysis;
export function assertAllowedImportSpecifiers(source: string): ImportSpecifierAnalysis;
export function walkRegularFiles(directory: string, options?: WalkOptions): Promise<string[]>;
export function publishArtifact(
  staging: string,
  target: string,
  backup: string,
  operations?: PublishOperations,
): Promise<void>;
export function buildRelease(): Promise<void>;
export function verifyRelease(): Promise<void>;
