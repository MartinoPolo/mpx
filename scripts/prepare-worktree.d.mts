export interface WorktreePortOptions {
  file: string;
  ports: { name: string; base: number }[];
  offset: number;
}

export function normalizeNativeWindowsPath(
  value: string | undefined,
  platform?: NodeJS.Platform,
): string | undefined;
export function prepareWorktree(rootPath: string | undefined, worktreePath: string | undefined): Promise<void>;
export function assignWorktreePorts(
  worktreePath: string | undefined,
  options: WorktreePortOptions,
): Promise<{ slot: number; values: { name: string; value: number }[] } | undefined>;
