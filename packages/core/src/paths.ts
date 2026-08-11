import { realpath } from "node:fs/promises";
import path from "node:path";

export async function canonicalRealpath(value: string): Promise<string> {
  return path.normalize(await realpath(value));
}

export interface PathMatchOptions { platform?: NodeJS.Platform }

function normalized(value: string, platform: NodeJS.Platform): string {
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const result = implementation.resolve(value);
  return platform === "win32" ? result.toLowerCase() : result;
}

export function isPathWithinRoot(candidate: string, root: string, options: PathMatchOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const candidatePath = normalized(candidate, platform);
  const rootPath = normalized(root, platform);
  const relative = implementation.relative(rootPath, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${implementation.sep}`) && !implementation.isAbsolute(relative));
}

export function selectLongestMatchingRoot(candidate: string, roots: readonly string[], options: PathMatchOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  return roots.filter((root) => isPathWithinRoot(candidate, root, options))
    .sort((left, right) => normalized(right, platform).length - normalized(left, platform).length)[0];
}
