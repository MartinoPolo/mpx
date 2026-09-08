import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseUserConfig, type UserConfig } from '@mpx/config';
import { MpxError, parseStrictJson } from '@mpx/core';
import {
  INSTALL_EXECUTABLE_MAX_BYTES,
  inspectPiSettingsRoot,
  NodePiNativeSettingsPort,
  UserConfigPiPrivateRootResolver,
  readActiveRelease,
  parsePiSettings,
  type CurrentInstallationProbe,
  PiLegacyDetachService,
  type InstallIntentBuilder,
  type InstallIntentRequestV1,
  type InstallOrchestrator,
  type PiLegacyDetachConfig,
} from '@mpx/installer';
import { SetupApplicationService, type SetupRequestFactory } from '../setup-application-service.js';
import { resolveTrustedRuntimeExecutable } from './launch-execution-adapters.js';
import { LegacyPiExtensionCleanupService } from './legacy-pi-extension-cleanup.js';
import { ObsoleteAccountStateResetService } from './obsolete-account-state-reset.js';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_VERSION_BYTES = 16 * 1024;
const MAX_VERSION_LENGTH = 256;

function invalid(code: string, message: string): never {
  throw new MpxError({ code, message });
}

function absoluteEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value))) {
    invalid('SETUP_ENVIRONMENT_INVALID', `${name} must be an absolute path.`);
  }
  return value;
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint; size: number },
  right: { dev: number | bigint; ino: number | bigint; size: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function readSecureConfig(file: string): Promise<string> {
  const namedBefore = await lstat(file);
  if (
    namedBefore.isSymbolicLink() ||
    !namedBefore.isFile() ||
    namedBefore.size > MAX_CONFIG_BYTES
  ) {
    throw new Error('unsafe configuration');
  }
  const handle = await open(file, 'r');
  try {
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || !sameFile(namedBefore, openedBefore)) {
      throw new Error('configuration identity changed');
    }
    const body = Buffer.alloc(openedBefore.size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (bytesRead === 0) {
        throw new Error('configuration truncated');
      }
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, body.length)).bytesRead !== 0) {
      throw new Error('configuration grew');
    }
    const [openedAfter, namedAfter] = await Promise.all([handle.stat(), lstat(file)]);
    if (
      namedAfter.isSymbolicLink() ||
      !sameFile(openedBefore, openedAfter) ||
      !sameFile(openedBefore, namedAfter)
    ) {
      throw new Error('configuration identity changed');
    }
    return body.toString('utf8');
  } finally {
    await handle.close();
  }
}

function homeCandidate(environment: NodeJS.ProcessEnv): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [environment.USERPROFILE, environment.HOME]
      : [environment.HOME, environment.USERPROFILE];
  return candidates.find(
    (candidate): candidate is string =>
      !!candidate && (path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)),
  );
}

function resolveHome(environment: NodeJS.ProcessEnv): string {
  const candidate = homeCandidate(environment);
  if (!candidate || (!path.win32.isAbsolute(candidate) && !path.posix.isAbsolute(candidate))) {
    return invalid('SETUP_ROOT_INVALID', 'The Pi runtime roots could not be resolved.');
  }
  return candidate;
}

function resolveTildeRoot(value: string, environment: NodeJS.ProcessEnv): string {
  if (value !== '~' && !value.startsWith('~/') && !value.startsWith('~\\')) {
    if (value.startsWith('~') || (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value))) {
      return invalid('SETUP_ROOT_INVALID', 'The Pi runtime roots could not be resolved.');
    }
    return value;
  }
  const home = resolveHome(environment);
  if (value === '~') {
    return home;
  }
  return path.join(home, ...value.slice(2).split(/[\\/]+/u));
}

function preserveRawRuntimeRoots(config: UserConfig, text: string): UserConfig {
  const raw = JSON.parse(text) as {
    identities: Record<string, { runtimeRoots: Record<string, string> }>;
  };
  const preserved = structuredClone(config);
  for (const [name, identity] of Object.entries(preserved.identities)) {
    identity.runtimeRoots = {
      ...raw.identities[name]!.runtimeRoots,
    } as typeof identity.runtimeRoots;
  }
  return preserved;
}

export function resolvePiDetachConfig(
  config: UserConfig,
  environment: NodeJS.ProcessEnv,
): PiLegacyDetachConfig {
  const identities = Object.fromEntries(
    Object.entries(config.identities).map(([name, identity]) => [
      name,
      {
        domain: identity.domain,
        runtimeRoots: { pi: resolveTildeRoot(identity.runtimeRoots.pi, environment) },
      },
    ]),
  );
  const roots = Object.values(identities).map((value) => value.runtimeRoots.pi);
  const normalized = roots.map((value) =>
    path
      .normalize(value)
      .replace(/[\\/]+$/u, '')
      .toLowerCase(),
  );
  if (new Set(normalized).size !== normalized.length) {
    return invalid('SETUP_ROOT_INVALID', 'The Pi runtime roots could not be resolved.');
  }
  return { identities };
}

async function ensurePrivateStateRoot(localAppData: string): Promise<string> {
  try {
    const localInfo = await lstat(localAppData);
    if (localInfo.isSymbolicLink() || !localInfo.isDirectory()) {
      return invalid('SETUP_STATE_INVALID', 'The setup state directory is unsafe.');
    }
    const localReal = await realpath(localAppData);
    const stateRoot = path.join(localAppData, 'mpx');
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const stateInfo = await lstat(stateRoot);
    const stateReal = await realpath(stateRoot);
    const relative = path.relative(localReal, stateReal);
    if (
      stateInfo.isSymbolicLink() ||
      !stateInfo.isDirectory() ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return invalid('SETUP_STATE_INVALID', 'The setup state directory is unsafe.');
    }
    return stateRoot;
  } catch (error) {
    if (error instanceof MpxError) {
      throw error;
    }
    return invalid('SETUP_STATE_INVALID', 'The setup state directory is unsafe.');
  }
}

export interface SetupProcessPort {
  version(executable: string, argv: readonly string[]): Promise<string>;
}

export function createNodeSetupProcessPort(): SetupProcessPort {
  return {
    version(executable, argv) {
      return new Promise((resolve, reject) => {
        execFile(
          executable,
          [...argv],
          { shell: false, timeout: 5_000, maxBuffer: MAX_VERSION_BYTES, windowsHide: true },
          (error, stdout, stderr) => {
            if (error) {
              reject(error);
            } else {
              resolve(stdout || stderr);
            }
          },
        );
      });
    },
  };
}

async function executable(
  environment: NodeJS.ProcessEnv,
  name: 'MPX_CLAUDE_EXECUTABLE' | 'MPX_PI_EXECUTABLE',
  processPort: SetupProcessPort,
): Promise<{ path: string; version: string }> {
  const original = absoluteEnvironment(environment, name);
  try {
    const info = await lstat(original);
    if (!info.isFile() || info.isSymbolicLink() || info.size > INSTALL_EXECUTABLE_MAX_BYTES) {
      throw new Error('unsafe executable');
    }
    const runtime = name === 'MPX_PI_EXECUTABLE' ? 'pi' : 'claude';
    const trusted = await resolveTrustedRuntimeExecutable({
      runtime,
      cwd: absoluteEnvironment(environment, 'MPX_PROJECTS'),
      environment,
    });
    const output = await processPort.version(trusted.executable, [
      ...trusted.argvPrefix,
      '--version',
    ]);
    if (
      Buffer.byteLength(output, 'utf8') > MAX_VERSION_BYTES ||
      /[\0-\u0009\u000b\u000c\u000e-\u001f\u007f]/u.test(output)
    ) {
      throw new Error('invalid output');
    }
    const version = output.replace(/[\r\n\t ]+/gu, ' ').trim();
    if (!version || version.length > MAX_VERSION_LENGTH) {
      throw new Error('invalid version');
    }
    return { path: original, version };
  } catch {
    return invalid('SETUP_EXECUTABLE_INVALID', `${name} is not a usable executable.`);
  }
}

function identity(config: UserConfig, domain: 'personal' | 'work') {
  const matches = Object.entries(config.identities).filter(([, value]) => value.domain === domain);
  if (matches.length !== 1) {
    invalid('SETUP_IDENTITY_INVALID', `Setup requires exactly one ${domain} identity.`);
  }
  return matches[0]!;
}

function provider(routes: Readonly<Record<string, string>> | undefined, preferred: string): string {
  const keys = Object.keys(routes ?? {}).sort((a, b) => a.localeCompare(b));
  if (keys.includes(preferred)) {
    return preferred;
  }
  if (keys.length === 1) {
    return keys[0]!;
  }
  return invalid(
    'SETUP_PROVIDER_INVALID',
    'A provider route could not be selected from configuration.',
  );
}

export class NodeSetupRequestFactory implements SetupRequestFactory {
  #config: UserConfig | undefined;
  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly processPort: SetupProcessPort = createNodeSetupProcessPort(),
  ) {}

  config(): UserConfig {
    return this.#config ?? invalid('SETUP_CONFIG_INVALID', 'Setup configuration is unavailable.');
  }

  async create(): Promise<InstallIntentRequestV1> {
    const appData = absoluteEnvironment(this.environment, 'APPDATA');
    absoluteEnvironment(this.environment, 'LOCALAPPDATA');
    absoluteEnvironment(this.environment, 'MPX_PROJECTS');
    absoluteEnvironment(this.environment, 'MPX_APPS');
    const configFile = path.join(appData, 'mpx', 'config.json');
    let config: UserConfig;
    try {
      const text = await readSecureConfig(configFile);
      const validationHome = homeCandidate(this.environment) ?? path.parse(configFile).root;
      const validated = parseUserConfig(text, {
        ...this.environment,
        USERPROFILE: validationHome,
        HOME: validationHome,
      });
      config = preserveRawRuntimeRoots(validated, text);
    } catch {
      return invalid('SETUP_CONFIG_INVALID', 'Setup configuration is invalid or unreadable.');
    }
    const [personalName, personal] = identity(config, 'personal');
    const [workName, work] = identity(config, 'work');
    const claude = await executable(this.environment, 'MPX_CLAUDE_EXECUTABLE', this.processPort);
    const pi = await executable(this.environment, 'MPX_PI_EXECUTABLE', this.processPort);
    this.#config = config;
    return {
      schemaVersion: 1,
      kind: 'install-intent-request',
      userConfigPath: configFile,
      identities: { personal: personalName, work: workName },
      providers: {
        personal: provider(personal.providerRoutes, 'github'),
        work: provider(work.providerRoutes, 'gitlab'),
      },
      executables: { claude, pi },
      projections: {
        claude: [
          { path: 'content/agents/metadata.json', role: 'agents' },
          { path: 'content/instructions/global/AGENTS.md', role: 'canonical-content' },
          {
            path: 'content/instructions/runtime/claude/CLAUDE.md',
            role: 'canonical-content',
          },
          { path: 'content/output-styles/mpx-terse.md', role: 'canonical-content' },
          { path: 'runtimes/claude/runtime-claude/COMPATIBILITY.md', role: 'settings' },
          { path: 'runtimes/claude/runtime-claude/package.json', role: 'status' },
          { path: 'runtimes/claude/runtime-claude/src/index.ts', role: 'plugin' },
          { path: 'runtimes/claude/runtime-claude/src/runtime-tools.ts', role: 'hooks' },
          { path: 'runtimes/pi/extensions/subagents/LICENSE', role: 'licenses' },
        ],
        pi: [
          { path: 'content/agents/metadata.json', role: 'agents' },
          { path: 'content/instructions/global/AGENTS.md', role: 'canonical-content' },
          { path: 'content/instructions/runtime/pi/APPEND_SYSTEM.md', role: 'canonical-content' },
          { path: 'runtimes/pi/extensions/subagents/LICENSE', role: 'licenses' },
          { path: 'runtimes/pi/runtime-pi/src/profile.ts', role: 'profile' },
        ],
      },
    };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw failure;
  }
}

async function containsInstallationArtifact(target: string): Promise<boolean> {
  if (!(await exists(target))) {
    return false;
  }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return true;
  }
  for (const name of await readdir(target)) {
    if (await containsInstallationArtifact(path.join(target, name))) {
      return true;
    }
  }
  return false;
}

export function createNodeCurrentInstallationProbe(
  environment: NodeJS.ProcessEnv,
): CurrentInstallationProbe {
  const localAppData = absoluteEnvironment(environment, 'LOCALAPPDATA');
  const nativeSettings = new NodePiNativeSettingsPort();
  const privateRoots = new UserConfigPiPrivateRootResolver(environment);
  return {
    async observe(intent) {
      const selectedReleaseKey = (await exists(path.join(localAppData, 'mpx', 'active-release')))
        ? await readActiveRelease(localAppData)
        : null;
      const hasArtifacts = (
        await Promise.all(
          [
            ...['installer/registrations', 'runtime-projections'].map((relative) =>
              path.join(localAppData, 'mpx', relative),
            ),
            path.join(absoluteEnvironment(environment, 'MPX_APPS'), 'mpx', 'bin'),
          ].map(containsInstallationArtifact),
        )
      ).some(Boolean);
      const piRoots = [];
      for (const registration of intent.runtimeRegistrations?.registrations ?? []) {
        if (registration.runtime !== 'pi') {
          continue;
        }
        const root = await privateRoots.resolvePiNativeRoot({
          identity: registration.identity,
          expectedNativeRootDigest: registration.nativeRootDigest,
          ...(intent.userConfigArtifact
            ? { userConfigArtifactContent: intent.userConfigArtifact.content }
            : {}),
        });
        const settingsPath = path.join(root, 'settings.json');
        const legacyLink =
          (await exists(settingsPath)) && (await lstat(settingsPath)).isSymbolicLink();
        const settings = legacyLink
          ? parsePiSettings(
              parseStrictJson((await nativeSettings.read(settingsPath)).toString('utf8')),
            )
          : (await inspectPiSettingsRoot(nativeSettings, root)).settings;
        piRoots.push({
          identity: registration.identity,
          domain: registration.domain,
          nativeRootDigest: registration.nativeRootDigest,
          settings,
        });
      }
      return { selectedReleaseKey, hasArtifacts, piRoots };
    },
  };
}

export function createNodeSetupApplicationService(dependencies: {
  readonly environment: NodeJS.ProcessEnv;
  readonly builder: Pick<InstallIntentBuilder, 'build'>;
  readonly orchestrator: Pick<
    InstallOrchestrator,
    'admitCurrentInstallation' | 'plan' | 'apply' | 'verify'
  >;
  readonly processPort?: SetupProcessPort;
}): SetupApplicationService {
  const requestFactory = new NodeSetupRequestFactory(
    dependencies.environment,
    dependencies.processPort,
  );
  const projectsRoot = absoluteEnvironment(dependencies.environment, 'MPX_PROJECTS');
  const localAppData = absoluteEnvironment(dependencies.environment, 'LOCALAPPDATA');
  return new SetupApplicationService({
    requestFactory: {
      create: async () => {
        await ensurePrivateStateRoot(localAppData);
        return requestFactory.create();
      },
    },
    builder: dependencies.builder,
    orchestrator: dependencies.orchestrator,
    installationProbe: createNodeCurrentInstallationProbe(dependencies.environment),
    localReset: {
      run: async () => {
        await ensurePrivateStateRoot(localAppData);
        await new ObsoleteAccountStateResetService(localAppData).run();
      },
    },
    detach: {
      run: async () => {
        const detach = new PiLegacyDetachService({
          config: resolvePiDetachConfig(requestFactory.config(), dependencies.environment),
          projectsRoot,
          stateRoot: await ensurePrivateStateRoot(localAppData),
        });
        await detach.run();
        // Recovery may only restore links; a second run completes detachment or verifies the receipt.
        await detach.run();
      },
    },
    legacyPiExtensionsCleanup: {
      run: async () => {
        const config = resolvePiDetachConfig(requestFactory.config(), dependencies.environment);
        await new LegacyPiExtensionCleanupService({
          piRoots: Object.values(config.identities).map((value) => value.runtimeRoots.pi),
          projectsRoot,
        }).run();
      },
    },
  });
}
