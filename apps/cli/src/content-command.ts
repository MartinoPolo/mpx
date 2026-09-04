import {
  ActiveContentError,
  checkActiveContentProjection,
  loadActiveContentProjection,
  readActiveContentEntry,
} from '@mpx/content-compiler';
import { MpxError } from '@mpx/core';

export interface ContentCommandResult {
  readonly data: unknown;
  readonly rawOutput?: string;
}

export async function executeContentCommand(input: {
  readonly action: string | undefined;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): Promise<ContentCommandResult> {
  try {
    const active = await loadActiveContentProjection({
      root: input.env.MPX_ACTIVE_CONTENT_ROOT,
      manifestPath: input.env.MPX_ACTIVE_CONTENT_MANIFEST,
    });
    if (input.action === 'current' && input.args.length === 0) {
      return {
        data: { root: active.root, manifest: active.manifestPath },
        rawOutput: `${active.root}\n${active.manifestPath}\n`,
      };
    }
    if (input.action === 'list' && input.args.length === 0) {
      return {
        data: {
          skills: active.manifest.skills.map((entry) => ({
            identity: entry.identity,
            path: entry.generatedPath,
            exposure: entry.exposure,
            description: entry.effectiveDescription,
          })),
          agents: active.manifest.agents.map((entry) => ({
            identity: entry.canonicalIdentity,
            projectedIdentity: entry.projectedIdentity,
            path: entry.generatedPath,
            model: entry.concreteModel,
          })),
        },
      };
    }
    if (
      input.action === 'show' &&
      input.args.length === 2 &&
      (input.args[0] === 'skill' || input.args[0] === 'agent')
    ) {
      const bytes = await readActiveContentEntry(active, input.args[0], input.args[1]!);
      return {
        data: { kind: input.args[0], identity: input.args[1]!, byteCount: bytes.byteLength },
        rawOutput: bytes.toString('utf8'),
      };
    }
    if (input.action === 'check' && input.args.length === 0) {
      const checked = await checkActiveContentProjection(active);
      return {
        data: checked,
        rawOutput: `Active content clean (${checked.checkedFiles} files).\n`,
      };
    }
    throw new MpxError({ code: 'USAGE_ERROR', message: 'Invalid content command arguments.' });
  } catch (error) {
    if (error instanceof ActiveContentError) {
      throw new MpxError({ code: error.code, message: error.message });
    }
    throw error;
  }
}
