import { lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';

export interface ProjectSetupResult { status: 'linked' | 'missing-source' | 'planned' | 'conflict'; source: string; destination: string; diagnostic?: string }
/** Optional project-owned sharing action. No manifest, Orca or ignore configuration writes. */
export async function setupProject(directory: string, preview = false): Promise<ProjectSetupResult> {
  const root = path.resolve(directory);
  const source = path.join(root, '.agents/skills'); const destination = path.join(root, '.claude/skills');
  const base = { source, destination };
  // Refuse linked ancestors for mutations; the caller can perform its own explicit link action.
  let cursor = root;
  while (true) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) return { ...base, status: 'conflict', diagnostic: `Project path component is not a physical directory: ${cursor}` };
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const agents = await lstat(path.join(root, '.agents')).catch(() => undefined);
  const skills = await lstat(source).catch(() => undefined);
  if (!agents || !skills) return { ...base, status: 'missing-source', diagnostic: 'No project-owned .agents/skills exists; nothing to link.' };
  if (!agents.isDirectory() || agents.isSymbolicLink() || !skills.isDirectory() || skills.isSymbolicLink()) return { ...base, status: 'conflict', diagnostic: 'Project skill source must be a physical project-owned directory.' };
  const claude = path.dirname(destination);
  const native = await lstat(claude).catch(() => undefined);
  if (native && (!native.isDirectory() || native.isSymbolicLink())) return { ...base, status: 'conflict', diagnostic: 'Existing .claude path is preserved; explicit replacement approval required.' };
  const existing = await lstat(destination).catch(() => undefined);
  if (existing) {
    if (existing.isSymbolicLink() && path.resolve(claude, await readlink(destination)).toLowerCase() === source.toLowerCase()) return { ...base, status: 'linked' };
    return { ...base, status: 'conflict', diagnostic: 'Existing skill discovery entry is preserved; projects own link conflicts.' };
  }
  if (preview) return { ...base, status: 'planned' };
  await mkdir(claude, { recursive: true });
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  return { ...base, status: 'linked' };
}

export function orcaProjectSnippet(): string {
  return `# Add with Orca's project configuration UI / project-owned orca.yaml. MPX never writes it.\n# WORK · Pi: piw\n# WORK · Claude: ccw\n# Resume · Native: mpx resume\n# Setup command (optional): mpx project setup . --non-interactive\n# Worktree base: ../worktrees; nested by repository\n# Development servers: project-owned commands; free ports, native Orca URL discovery.\n`;
}
