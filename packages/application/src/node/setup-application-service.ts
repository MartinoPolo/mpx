import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseUserConfig, type UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import {
  INSTALL_EXECUTABLE_MAX_BYTES,
  PiLegacyDetachService,
  type InstallIntentBuilder,
  type InstallIntentRequestV1,
  type InstallOrchestrator,
} from '@mpx/installer';
import { SetupApplicationService, type SetupRequestFactory } from '../setup-application-service.js';

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
  return path.normalize(value);
}

export interface SetupProcessPort {
  version(executable: string): Promise<string>;
}

export function createNodeSetupProcessPort(): SetupProcessPort {
  return {
    version(executable) {
      return new Promise((resolve, reject) => {
        execFile(
          executable,
          ['--version'],
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
  const file = absoluteEnvironment(environment, name);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > INSTALL_EXECUTABLE_MAX_BYTES) {
      throw new Error('unsafe executable');
    }
    const output = await processPort.version(file);
    if (Buffer.byteLength(output, 'utf8') > MAX_VERSION_BYTES) {
      throw new Error('large output');
    }
    const version = output.replace(/[\r\n\t ]+/gu, ' ').trim();
    if (!version || version.length > MAX_VERSION_LENGTH || /\0/u.test(version)) {
      throw new Error('invalid version');
    }
    return { path: file, version };
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
      const info = await lstat(configFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
        throw new Error('unsafe configuration');
      }
      config = parseUserConfig(await readFile(configFile, 'utf8'), this.environment);
    } catch {
      return invalid('SETUP_CONFIG_INVALID', 'Setup configuration is invalid or unreadable.');
    }
    const [personalName, personal] = identity(config, 'personal');
    const [workName, work] = identity(config, 'work');
    const [claude, pi] = await Promise.all([
      executable(this.environment, 'MPX_CLAUDE_EXECUTABLE', this.processPort),
      executable(this.environment, 'MPX_PI_EXECUTABLE', this.processPort),
    ]);
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
          { path: 'content/output-styles/mpx-terse.md', role: 'canonical-content' },
          { path: 'runtimes/claude/runtime-claude/COMPATIBILITY.md', role: 'settings' },
          { path: 'runtimes/claude/runtime-claude/src/index.ts', role: 'plugin' },
          { path: 'runtimes/claude/runtime-claude/src/runtime-status.ts', role: 'status' },
          { path: 'runtimes/claude/runtime-claude/src/runtime-tools.ts', role: 'hooks' },
          { path: 'runtimes/pi/extensions/subagents/LICENSE', role: 'licenses' },
        ],
        pi: [
          { path: 'content/agents/metadata.json', role: 'agents' },
          { path: 'content/instructions/runtime/pi/APPEND_SYSTEM.md', role: 'canonical-content' },
          { path: 'runtimes/pi/extensions/subagents/LICENSE', role: 'licenses' },
          { path: 'runtimes/pi/runtime-pi/src/profile.ts', role: 'profile' },
        ],
      },
      external: { gitRemotes: [] },
    };
  }
}

export function createNodeSetupApplicationService(dependencies: {
  readonly environment: NodeJS.ProcessEnv;
  readonly builder: Pick<InstallIntentBuilder, 'build' | 'verify'>;
  readonly orchestrator: Pick<InstallOrchestrator, 'plan' | 'apply' | 'verify'>;
  readonly processPort?: SetupProcessPort;
}): SetupApplicationService {
  const requestFactory = new NodeSetupRequestFactory(
    dependencies.environment,
    dependencies.processPort,
  );
  const projectsRoot = absoluteEnvironment(dependencies.environment, 'MPX_PROJECTS');
  const localAppData = absoluteEnvironment(dependencies.environment, 'LOCALAPPDATA');
  return new SetupApplicationService({
    requestFactory,
    builder: dependencies.builder,
    orchestrator: dependencies.orchestrator,
    detach: {
      run: () =>
        new PiLegacyDetachService({
          config: requestFactory.config(),
          projectsRoot,
          stateRoot: path.join(localAppData, 'mpx'),
        }).run(),
    },
  });
}
