import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { parseStrictJson } from './strict-json.js';
import { assertValid, validateProject } from './schema.js';
import { isDirectoryProjectConfig, type ProjectConfig } from './types.js';
export interface DiscoveredConfig {
  path: string;
  root: string;
  config: ProjectConfig;
}
async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
export async function discoverProjectConfig(
  start = process.cwd(),
): Promise<DiscoveredConfig | undefined> {
  let dir = await realpath(start);
  const requestedRoot = dir;
  while (true) {
    const file = join(dir, 'mpxconfig.json');
    if (await exists(file)) {
      const value = parseStrictJson(await readFile(file, 'utf8'));
      assertValid(validateProject, value);
      if (isDirectoryProjectConfig(value) && dir !== requestedRoot) {
        return undefined;
      }
      return { path: file, root: dir, config: value };
    }
    if (await exists(join(dir, '.git'))) {
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) {
      return undefined;
    }
    dir = parent;
  }
}
