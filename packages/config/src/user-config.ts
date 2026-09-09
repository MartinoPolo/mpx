import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertValid, ConfigValidationError, validateUserConfig } from './schema.js';
import { parseStrictJson } from './strict-json.js';
import type { UserConfig } from './types.js';

const allowedRootVariables = new Set([
  'MPX_PROJECTS',
  'MPX_WORK',
  'MPX_CLONED',
  'MPX_APPS',
  'MPX_ONEDRIVE',
  'MPX_AI_GENERATED',
  'MPX_OBSIDIAN_VAULT',
]);
const fullToken = /^\$\{(MPX_[A-Z0-9_]+)\}$/u;
const secretLike =
  /(?:^|[._-])(secret|token|password|credential|api[._-]?key|private[._-]?key)(?:$|[._-])/iu;
const routeLabelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const unsafeRoutePattern =
  /(?:^|[._-])(?:secret|token|password|credential|api[._-]?key|private[._-]?key)(?:$|[._-])|^id_(?:rsa|dsa|ecdsa|ed25519|xmss)(?:_sk)?(?:[._-].*)?$|\.(?:exe|cmd|bat|com|ps1|pem|key|ppk)$/iu;
const permittedSecurityKeys = new Set(['shareNativeAuth']);

export function isSafeRouteLabel(value: string): boolean {
  return routeLabelPattern.test(value) && !unsafeRoutePattern.test(value);
}

function validationError(instancePath: string, message: string): ConfigValidationError {
  return new ConfigValidationError([
    { instancePath, schemaPath: '#/semantic', keyword: 'semantic', params: {}, message },
  ]);
}

function absoluteRoot(value: string, pointer: string): string {
  if (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
    throw validationError(pointer, 'must be an absolute root path');
  }
  return value;
}

function rootToken(value: unknown, environment: NodeJS.ProcessEnv, pointer: string): string {
  if (typeof value !== 'string') {
    throw validationError(pointer, 'must be a root path');
  }
  const match = fullToken.exec(value);
  if (!match) {
    if (value.includes('${')) {
      throw validationError(pointer, 'uses an unsupported environment root token');
    }
    return absoluteRoot(value, pointer);
  }
  const variable = match[1]!;
  if (!allowedRootVariables.has(variable)) {
    throw validationError(pointer, 'uses an unsupported environment root token');
  }
  const resolved = environment[variable];
  if (!resolved) {
    throw validationError(pointer, `requires unavailable environment root ${variable}`);
  }
  return absoluteRoot(resolved, pointer);
}

function nativeRuntimeRoot(
  value: unknown,
  environment: NodeJS.ProcessEnv,
  pointer: string,
): string {
  if (typeof value !== 'string') {
    throw validationError(pointer, 'must be a native runtime root');
  }
  if (value.includes('${')) {
    throw validationError(pointer, `Environment interpolation is not allowed at ${pointer}`);
  }
  if (!value.startsWith('~')) {
    return absoluteRoot(value, pointer);
  }
  if (value !== '~' && !value.startsWith('~/') && !value.startsWith('~\\')) {
    throw validationError(pointer, 'uses an unsupported home path');
  }
  const home = environment.USERPROFILE ?? environment.HOME;
  if (!home) {
    throw validationError(pointer, 'cannot resolve the platform user home');
  }
  if (value === '~') {
    return absoluteRoot(home, pointer);
  }
  const separator = home.includes('/') && !home.includes('\\') ? '/' : path.sep;
  return absoluteRoot(
    `${home.replace(/[\\/]$/u, '')}${separator}${value.slice(2).replaceAll('\\', separator).replaceAll('/', separator)}`,
    pointer,
  );
}

function rejectUndocumentedInterpolation(value: unknown, pointer = ''): void {
  if (typeof value === 'string' && value.includes('${')) {
    const documentedRoot =
      /^\/domains\/[^/]+\/\d+$/u.test(pointer) ||
      /^\/locations\/[^/]+\/roots\/\d+$/u.test(pointer) ||
      /^\/resourceRoots\/[^/]+\/\d+$/u.test(pointer) ||
      /^\/localIssueStores\/[^/]+\/root$/u.test(pointer) ||
      /^\/localViews\/[^/]+\/(?:vaultRoot|outputRoot)$/u.test(pointer);
    if (!documentedRoot) {
      throw validationError(
        pointer || '/',
        `Environment interpolation is not allowed at ${pointer || '/'}`,
      );
    }
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectUndocumentedInterpolation(entry, `${pointer}/${index}`));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      rejectUndocumentedInterpolation(entry, `${pointer}/${key}`);
    }
  }
}

function rejectSecretMaterial(value: unknown, pointer = ''): void {
  if (typeof value === 'string' && secretLike.test(value)) {
    throw validationError(pointer || '/', 'must not contain secret-like material');
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretMaterial(entry, `${pointer}/${index}`));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (!permittedSecurityKeys.has(key) && secretLike.test(key)) {
        throw validationError(`${pointer}/${key}`, 'secret-like keys are forbidden');
      }
      rejectSecretMaterial(entry, `${pointer}/${key}`);
    }
  }
}

export function interpolateUserConfig(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const result = structuredClone(value) as Record<string, unknown>;
  rejectUndocumentedInterpolation(result);
  const domains = result.domains as Record<string, unknown[]> | undefined;
  for (const [name, roots] of Object.entries(domains ?? {})) {
    roots.forEach((root, index) => {
      roots[index] = rootToken(root, environment, `/domains/${name}/${index}`);
    });
  }
  const scopes = result.locations as Record<string, { roots?: unknown[] }> | undefined;
  for (const [name, scope] of Object.entries(scopes ?? {})) {
    scope.roots?.forEach((root, index) => {
      scope.roots![index] = rootToken(root, environment, `/locations/${name}/roots/${index}`);
    });
  }
  const resources = result.resourceRoots as Record<string, unknown[]> | undefined;
  for (const [name, roots] of Object.entries(resources ?? {})) {
    roots.forEach((root, index) => {
      roots[index] = rootToken(root, environment, `/resourceRoots/${name}/${index}`);
    });
  }
  const stores = result.localIssueStores as Record<string, { root?: unknown }> | undefined;
  for (const [name, store] of Object.entries(stores ?? {})) {
    if (store.root !== undefined) {
      store.root = rootToken(store.root, environment, `/localIssueStores/${name}/root`);
    }
  }
  const views = result.localViews as
    Record<string, { vaultRoot?: unknown; outputRoot?: unknown }> | undefined;
  for (const [name, view] of Object.entries(views ?? {})) {
    for (const field of ['vaultRoot', 'outputRoot'] as const) {
      if (view[field] !== undefined) {
        view[field] = rootToken(view[field], environment, `/localViews/${name}/${field}`);
      }
    }
  }
  const identities = result.identities as
    Record<string, { runtimeRoots?: Record<string, unknown> }> | undefined;
  for (const [name, identity] of Object.entries(identities ?? {})) {
    for (const runtime of ['claude', 'pi']) {
      if (identity.runtimeRoots?.[runtime] !== undefined) {
        identity.runtimeRoots[runtime] = nativeRuntimeRoot(
          identity.runtimeRoots[runtime],
          environment,
          `/identities/${name}/runtimeRoots/${runtime}`,
        );
      }
    }
  }
  return result;
}

const builtInModeLimits = {
  project: { 'selected-project': 'read-write' },
  developer: { 'identity-domain': 'read-write', 'cloned-repositories': 'read-only' },
  'computer-control': {
    'computer-control-config': 'read-write',
    'computer-control-executable-settings': 'staged-write',
  },
  unrestricted: { host: 'read-write' },
} as const;
const accessRank = { 'read-only': 0, 'staged-write': 1, 'read-write': 2 } as const;

function assertReferences(config: UserConfig): void {
  for (const [name, view] of Object.entries(config.localViews ?? {})) {
    const vault = path.resolve(view.vaultRoot),
      expected = path.resolve(vault, ...view.vaultSubtree.split('/')),
      output = path.resolve(view.outputRoot);
    const relative = path.relative(expected, output);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw validationError(
        `/localViews/${name}/outputRoot`,
        'must be contained by the configured MPX vault subtree',
      );
    }
  }
  for (const [name, identity] of Object.entries(config.identities)) {
    if (!config.domains[identity.domain]) {
      throw validationError(`/identities/${name}/domain`, 'references an unknown domain');
    }
    const routes = [
      identity.gitAuthorRoute,
      identity.sshRoute,
      ...Object.values(identity.providerRoutes ?? {}),
      ...(identity.mcpSharing?.allow ?? []),
    ].filter((route): route is string => route !== undefined);
    if (routes.some((route) => !isSafeRouteLabel(route))) {
      throw validationError(
        `/identities/${name}`,
        'route labels must be opaque and must not contain secret or private-key names',
      );
    }
  }
  for (const [name, mode] of Object.entries(config.modes)) {
    const limits = builtInModeLimits[name as keyof typeof builtInModeLimits] as Partial<
      Record<string, keyof typeof accessRank>
    >;
    for (const [resource, access] of Object.entries(mode.resources)) {
      const limit = limits[resource];
      if (!limit || accessRank[access] > accessRank[limit]) {
        throw validationError(
          `/modes/${name}/resources/${resource}`,
          'widens the built-in mode policy',
        );
      }
    }
  }
  for (const [name, preset] of Object.entries(config.presets)) {
    const references: Array<[string, boolean]> = [
      ['identity', preset.identity in config.identities],
      ['mode', preset.mode in config.modes],
      ['executor', preset.executor in config.executors],
      ['networkPolicy', preset.networkPolicy in config.networkPolicies],
    ];
    for (const [field, valid] of references) {
      if (!valid) {
        throw validationError(`/presets/${name}/${field}`, `references an unknown ${field}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visitNetworkPolicy(name: string): void {
    if (visiting.has(name)) {
      throw validationError(`/networkPolicies/${name}/extends`, 'network policy extension cycle');
    }
    if (visited.has(name)) {
      return;
    }
    const policy = config.networkPolicies[name];
    if (!policy) {
      return;
    }
    visiting.add(name);
    if (policy.extends) {
      if (!(policy.extends in config.networkPolicies)) {
        throw validationError(
          `/networkPolicies/${name}/extends`,
          'references an unknown network policy',
        );
      }
      visitNetworkPolicy(policy.extends);
    }
    visiting.delete(name);
    visited.add(name);
  }
  Object.keys(config.networkPolicies).forEach(visitNetworkPolicy);

  function assertLaunchDefault(pointer: string, identityName: string, presetName: string): void {
    if (!(identityName in config.identities)) {
      throw validationError(pointer, 'references an unknown identity');
    }
    const preset = config.presets[presetName];
    if (!preset) {
      throw validationError(pointer, 'references an unknown preset');
    }
    if (preset.identity !== identityName) {
      throw validationError(pointer, 'preset identity must match the launch-default identity key');
    }
    if (
      preset.executor === 'host' ||
      preset.mode === 'unrestricted' ||
      preset.workspace === 'direct'
    ) {
      throw validationError(
        pointer,
        'launch default cannot select host execution, unrestricted mode, or direct workspace',
      );
    }
  }
  for (const [scopeName, defaults] of Object.entries(config.launchDefaults.locations)) {
    if (!(scopeName in config.locations)) {
      throw validationError(
        `/launchDefaults/locations/${scopeName}`,
        'references an unknown location',
      );
    }
    for (const [identityName, presetName] of Object.entries(defaults)) {
      assertLaunchDefault(
        `/launchDefaults/locations/${scopeName}/${identityName}`,
        identityName,
        presetName,
      );
    }
  }
  for (const [projectId, defaults] of Object.entries(config.launchDefaults.projects)) {
    for (const [identityName, presetName] of Object.entries(defaults)) {
      assertLaunchDefault(
        `/launchDefaults/projects/${projectId}/${identityName}`,
        identityName,
        presetName,
      );
    }
  }
}

export function parseUserConfig(
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
): UserConfig {
  const parsed = parseStrictJson(text);
  rejectSecretMaterial(parsed);
  const value = interpolateUserConfig(parsed, environment);
  assertValid(validateUserConfig, value);
  assertReferences(value);
  return value;
}

export async function loadUserConfig(
  file: string,
  environment?: NodeJS.ProcessEnv,
): Promise<UserConfig> {
  return parseUserConfig(await readFile(file, 'utf8'), environment);
}
