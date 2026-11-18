import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agentMcpServerNames } from './compiler.js';
import { CONNECTOR_URL_PATTERN, MCP_SERVER_NAME } from './contracts.js';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function projectMcpServerNames(projectRoot: string): Promise<string[]> {
  const file = join(projectRoot, '.mcp.json');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let servers: unknown;
  try { servers = (JSON.parse(text) as JsonObject | null)?.mcpServers; } catch (error) {
    process.stderr.write(`MPX: ${file} is not valid JSON, so the connector list does not allow its servers: ${error instanceof Error ? error.message : String(error)}\n`);
    return [];
  }
  const names = isJsonObject(servers) ? Object.keys(servers) : [];
  const unsupported = names.filter(name => !MCP_SERVER_NAME.test(name));
  if (unsupported.length > 0) {
    process.stderr.write(`MPX: the connector list cannot allow ${file} servers whose names do not match ${MCP_SERVER_NAME.source}: ${unsupported.join(', ')}\n`);
  }
  return names.filter(name => MCP_SERVER_NAME.test(name));
}

/**
 * Claude settings a project imposes on every launch: its disabled skills, and for a connector list an
 * `allowedMcpServers` allowlist. The allowlist also governs `.mcp.json` and agent-frontmatter servers, so
 * those join it by name. `serverCommand` entries are never emitted: one would stop `serverName` entries
 * from matching stdio servers.
 */
export async function projectClaudeSettings(options: {
  root: string; projectRoot: string; disabledSkills: string[]; connectors: boolean | string[] | undefined;
}): Promise<JsonObject> {
  const { root, projectRoot, disabledSkills, connectors } = options;
  const settings: JsonObject = {};
  if (disabledSkills.length > 0) settings.skillOverrides = Object.fromEntries(disabledSkills.map(name => [name, 'off']));
  if (Array.isArray(connectors)) {
    const urls = connectors.filter(entry => CONNECTOR_URL_PATTERN.test(entry));
    const names = [...connectors.filter(entry => !CONNECTOR_URL_PATTERN.test(entry)), ...await projectMcpServerNames(projectRoot), ...await agentMcpServerNames(root)];
    settings.allowedMcpServers = [...urls.map(serverUrl => ({ serverUrl })), ...[...new Set(names)].map(serverName => ({ serverName }))];
  }
  return settings;
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
 * Claude keeps only the last `--settings` value, so the project's settings are merged into the caller's
 * and passed as the single flag. Caller values win: per key inside objects such as `skillOverrides`,
 * and whole for anything else, such as `allowedMcpServers`.
 */
export async function claudeArgumentsWithSettings(callerArgs: string[], projectSettings: JsonObject, cwd: string): Promise<string[]> {
  if (Object.keys(projectSettings).length === 0) return callerArgs;
  const separator = callerArgs.indexOf('--');
  const optionsEnd = separator === -1 ? callerArgs.length : separator;
  const remaining: string[] = [];
  let callerSettingsValue: string | undefined;
  for (let index = 0; index < callerArgs.length; index++) {
    const argument = callerArgs[index]!;
    if (index < optionsEnd && argument === '--settings' && index + 1 < optionsEnd) callerSettingsValue = callerArgs[++index];
    else if (index < optionsEnd && argument.startsWith('--settings=')) callerSettingsValue = argument.slice('--settings='.length);
    else remaining.push(argument);
  }
  const callerSettings = callerSettingsValue === undefined ? {} : await readClaudeSettings(callerSettingsValue, cwd);
  const merged: JsonObject = { ...callerSettings };
  for (const [key, value] of Object.entries(projectSettings)) {
    const callerValue = callerSettings[key];
    if (callerValue === undefined) merged[key] = value;
    else if (isJsonObject(value) && isJsonObject(callerValue)) merged[key] = { ...value, ...callerValue };
  }
  return ['--settings', JSON.stringify(merged), ...remaining];
}
