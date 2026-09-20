import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function isMpx2RuntimeSelected(root: string, environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!['personal', 'work'].includes(environment.MPX_ACCOUNT ?? '')) return false;
  const selected = environment.MPX_ACTIVE_CONTENT_ROOT;
  if (!selected || !path.isAbsolute(selected)) return false;
  try {
    const [actual, expected] = await Promise.all([realpath(selected), realpath(root)]);
    return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch {
    return false;
  }
}
