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

const usageError = (): MpxError =>
  new MpxError({
    code: 'USAGE_ERROR',
    message: 'content requires check or inspect [<skill|agent> <identity>].',
  });

const compareIdentity = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export async function executeContentCommand(input: {
  readonly action: string | undefined;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): Promise<ContentCommandResult> {
  const inspectKind = input.args[0];
  const validInspect =
    input.action === 'inspect' &&
    (input.args.length === 0 ||
      (input.args.length === 2 && (inspectKind === 'skill' || inspectKind === 'agent')));
  const validCheck = input.action === 'check' && input.args.length === 0;
  if (!validInspect && !validCheck) {
    throw usageError();
  }

  try {
    const active = await loadActiveContentProjection({
      root: input.env.MPX_ACTIVE_CONTENT_ROOT,
      manifestPath: input.env.MPX_ACTIVE_CONTENT_MANIFEST,
    });

    if (input.action === 'check') {
      const checked = await checkActiveContentProjection(active);
      return {
        data: checked,
        rawOutput: `Active content clean (${checked.checkedFiles} files).\n`,
      };
    }

    if (input.args.length === 0) {
      const skills = active.manifest.skills
        .map((entry) => ({
          identity: entry.identity,
          path: entry.generatedPath,
          exposure: entry.exposure,
          description: entry.effectiveDescription,
        }))
        .sort((left, right) => compareIdentity(left.identity, right.identity));
      const agents = active.manifest.agents
        .map((entry) => ({
          identity: entry.canonicalIdentity,
          projectedIdentity: entry.projectedIdentity,
          path: entry.generatedPath,
          model: entry.concreteModel,
        }))
        .sort((left, right) => compareIdentity(left.identity, right.identity));
      return {
        data: { root: active.root, manifest: active.manifestPath, skills, agents },
        rawOutput: [
          `Active content: ${active.root}`,
          `Manifest: ${active.manifestPath}`,
          `Skills (${skills.length}):`,
          ...skills.map((entry) => `  ${entry.identity} — ${entry.description}`),
          `Agents (${agents.length}):`,
          ...agents.map(
            (entry) => `  ${entry.projectedIdentity} (${entry.identity}) — ${entry.model}`,
          ),
          '',
        ].join('\n'),
      };
    }

    const kind = inspectKind as 'skill' | 'agent';
    const requestedIdentity = input.args[1]!;
    const bytes = await readActiveContentEntry(active, kind, requestedIdentity);
    if (kind === 'skill') {
      const entry = active.manifest.skills.find((item) => item.identity === requestedIdentity)!;
      return {
        data: {
          kind,
          identity: entry.identity,
          path: entry.generatedPath,
          byteCount: bytes.byteLength,
          sha256: entry.generatedSha256,
        },
        rawOutput: bytes.toString('utf8'),
      };
    }

    const entry = active.manifest.agents.find(
      (item) =>
        item.canonicalIdentity === requestedIdentity ||
        item.projectedIdentity === requestedIdentity,
    )!;
    return {
      data: {
        kind,
        identity: entry.canonicalIdentity,
        projectedIdentity: entry.projectedIdentity,
        path: entry.generatedPath,
        byteCount: bytes.byteLength,
        sha256: entry.generatedSha256,
      },
      rawOutput: bytes.toString('utf8'),
    };
  } catch (error) {
    if (error instanceof ActiveContentError) {
      throw new MpxError({ code: error.code, message: error.message });
    }
    throw error;
  }
}
