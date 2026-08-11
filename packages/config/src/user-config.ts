import { readFile } from "node:fs/promises";
import { assertValid, validateUserConfig } from "./schema.js";
import { parseStrictJson } from "./strict-json.js";
import type { UserConfig } from "./types.js";

const allowedRootVariables = new Set([
  "MPX_PROJECTS",
  "MPX_WORK",
  "MPX_CLONED",
  "MPX_APPS",
  "MPX_ONEDRIVE",
  "MPX_AI_GENERATED",
  "MPX_OBSIDIAN_VAULT",
]);
const fullToken = /^\$\{(MPX_[A-Z0-9_]+)\}$/;

export function interpolateUserConfig(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): unknown {
  if (typeof value === "string") {
    if (!value.includes("${")) return value;
    const match = fullToken.exec(value);
    if (!match || !allowedRootVariables.has(match[1]!)) {
      throw new Error(`Unsupported environment root token: ${value}`);
    }
    const resolved = environment[match[1]!];
    if (!resolved) throw new Error(`Environment root is unavailable: ${match[1]}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((entry) => interpolateUserConfig(entry, environment));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateUserConfig(entry, environment)]),
    );
  }
  return value;
}

export function parseUserConfig(text: string, environment?: NodeJS.ProcessEnv): UserConfig {
  const value = interpolateUserConfig(parseStrictJson(text), environment);
  assertValid(validateUserConfig, value);
  return value;
}

export async function loadUserConfig(path: string, environment?: NodeJS.ProcessEnv): Promise<UserConfig> {
  return parseUserConfig(await readFile(path, "utf8"), environment);
}
