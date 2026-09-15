import { open } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

const MAX_SETTINGS_BYTES = 128 * 1024;

export interface FooterCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
}

type CompactionOverride = Partial<FooterCompactionSettings>;
type ReadResult = { missing: true } | { missing: false; value: unknown };

async function readSettingsFile(file: string): Promise<ReadResult> {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.allocUnsafe(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SETTINGS_BYTES) throw new Error('Settings file exceeds size limit');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    return { missing: false, value: JSON.parse(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    throw error;
  } finally {
    await handle?.close();
  }
}

function compactionOverride(value: unknown): CompactionOverride | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const settings = value as Record<string, unknown>;
  const compaction = settings.compaction;
  if (compaction === undefined) return {};
  if (compaction === null || typeof compaction !== 'object' || Array.isArray(compaction)) return undefined;

  const source = compaction as Record<string, unknown>;
  const result: CompactionOverride = {};
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') return undefined;
    result.enabled = source.enabled;
  }
  if (source.reserveTokens !== undefined) {
    if (typeof source.reserveTokens !== 'number' || !Number.isFinite(source.reserveTokens)
      || !Number.isInteger(source.reserveTokens) || source.reserveTokens < 0) return undefined;
    result.reserveTokens = source.reserveTokens;
  }
  return result;
}

export async function readFooterCompactionSettings(
  cwd: string,
  agentDir: string = getAgentDir(),
): Promise<FooterCompactionSettings | undefined> {
  try {
    const [globalFile, projectFile] = await Promise.all([
      readSettingsFile(path.join(agentDir, 'settings.json')),
      readSettingsFile(path.join(cwd, '.pi', 'settings.json')),
    ]);
    const global = globalFile.missing ? {} : compactionOverride(globalFile.value);
    const project = projectFile.missing ? {} : compactionOverride(projectFile.value);
    if (!global || !project) return undefined;

    const settings = SettingsManager.inMemory({ compaction: { ...global, ...project } }).getCompactionSettings();
    return { enabled: settings.enabled, reserveTokens: settings.reserveTokens };
  } catch {
    return undefined;
  }
}
