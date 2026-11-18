import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readClaudeSettings(value: string, cwd: string): Promise<JsonObject> {
  const trimmed = value.trim();
  let settings: unknown;
  try {
    // Claude reads a value wrapped in braces as inline JSON and anything else as a file path.
    settings = JSON.parse(trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : await readFile(resolve(cwd, value), 'utf8'));
  } catch (error) {
    throw new Error(`Cannot merge --settings ${value}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonObject(settings)) throw new Error(`Cannot merge --settings ${value}: it is not a JSON object.`);
  return settings;
}

/**
 * Claude keeps only the last `--settings` value, so the project's skill overrides are merged into the
 * caller's settings and passed as the single flag. A caller's own override of the same skill wins.
 */
export async function claudeArgumentsWithoutSkills(callerArgs: string[], disabledSkills: string[], cwd: string): Promise<string[]> {
  const separator = callerArgs.indexOf('--');
  const optionsEnd = separator === -1 ? callerArgs.length : separator;
  const remaining: string[] = [];
  let callerSettings: string | undefined;
  for (let index = 0; index < callerArgs.length; index++) {
    const argument = callerArgs[index]!;
    if (index < optionsEnd && argument === '--settings' && index + 1 < optionsEnd) callerSettings = callerArgs[++index];
    else if (index < optionsEnd && argument.startsWith('--settings=')) callerSettings = argument.slice('--settings='.length);
    else remaining.push(argument);
  }
  const settings = callerSettings === undefined ? {} : await readClaudeSettings(callerSettings, cwd);
  const skillOverrides = {
    ...Object.fromEntries(disabledSkills.map(name => [name, 'off'])),
    ...(isJsonObject(settings.skillOverrides) ? settings.skillOverrides : {}),
  };
  return ['--settings', JSON.stringify({ ...settings, skillOverrides }), ...remaining];
}
