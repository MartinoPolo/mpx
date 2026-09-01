import { lstat, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { MpxError, parseStrictJson } from '@mpx/core';
import {
  parseInstallIntentBuildResultV1,
  parseInstallIntentV1,
  parseInstallPlanV1,
} from '@mpx/installer';
import {
  InstallApplicationService,
  type InstallApplicationDependencies,
  type InstallProtocolInputPort,
} from '../install-application-service.js';

const MAX_PROTOCOL_BYTES = 1024 * 1024;

function fail(message: string): never {
  throw new MpxError({ code: 'INSTALL_USAGE_ERROR', message });
}

async function jsonFile(file: string): Promise<unknown> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROTOCOL_BYTES) {
      throw new Error('unsafe input');
    }
    return parseStrictJson(await readFile(file, 'utf8'));
  } catch (failure) {
    if (failure instanceof MpxError) {
      throw failure;
    }
    throw new MpxError({
      code: 'INSTALL_INPUT_UNREADABLE',
      message: 'Install protocol input is unreadable.',
    });
  }
}

export function createNodeInstallProtocolInput(): InstallProtocolInputPort {
  return {
    async request(source) {
      if (source.trim().startsWith('{')) {
        if (Buffer.byteLength(source, 'utf8') > MAX_PROTOCOL_BYTES) {
          fail('--request JSON exceeds the 1 MiB protocol bound');
        }
        return parseStrictJson(source);
      }
      return jsonFile(source);
    },
    async intent(source) {
      const value = await jsonFile(source);
      return value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value as { kind?: unknown }).kind === 'install-intent-build-result'
        ? parseInstallIntentBuildResultV1(value)
        : parseInstallIntentV1(value);
    },
    async plan(source) {
      return parseInstallPlanV1(await jsonFile(source));
    },
    async buildResult(source) {
      return parseInstallIntentBuildResultV1(await jsonFile(source));
    },
    evidence: jsonFile,
  };
}

export function createNodeInstallApplicationService(
  dependencies: Omit<InstallApplicationDependencies, 'input'>,
): InstallApplicationService {
  return new InstallApplicationService({
    ...dependencies,
    input: createNodeInstallProtocolInput(),
  });
}
