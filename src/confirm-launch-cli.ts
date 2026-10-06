import type { LaunchWarning } from './contracts.js';
import { LAUNCH_WARNING_CODE, launchWarningsRequireConfirmation, WARNING_SEVERITY } from './contracts.js';
import { confirmLaunch, formatLaunchWarning } from './launch.js';

const warningCodes = new Set<string>(Object.values(LAUNCH_WARNING_CODE));
const warningSeverities = new Set<string>(Object.values(WARNING_SEVERITY));

function isLaunchWarning(value: unknown): value is LaunchWarning {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.keys(value).length === 3
    && 'code' in value && typeof value.code === 'string' && warningCodes.has(value.code)
    && 'severity' in value && typeof value.severity === 'string' && warningSeverities.has(value.severity)
    && 'message' in value && typeof value.message === 'string';
}

export function parseLaunchWarnings(arguments_: readonly string[]): LaunchWarning[] {
  if (arguments_.length !== 1) throw new Error('Expected one JSON launch-warning argument.');
  let value: unknown;
  try {
    value = JSON.parse(arguments_[0]!);
  } catch {
    throw new Error('Launch warnings must be valid JSON.');
  }
  if (!Array.isArray(value) || !value.every(isLaunchWarning)) {
    throw new Error('Launch warnings do not match the required typed warning format.');
  }
  return value;
}

async function main(): Promise<void> {
  const warnings = parseLaunchWarnings(process.argv.slice(2));
  for (const warning of warnings) console.error(formatLaunchWarning(warning));
  // An empty list is an explicit acknowledgement request from a caller without diagnostics.
  await confirmLaunch({ requiresConfirmation: warnings.length === 0 || launchWarningsRequireConfirmation(warnings) });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
