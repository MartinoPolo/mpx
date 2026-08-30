import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type {
  BranchChildProcess,
  BranchRequestV1,
  ConversationBranchPlanV1,
  NativeBranchInvocation,
  TerminalTabPlan,
} from '@mpx/sessions';

export type ImmutableBranchLaunch = BranchRequestV1['launchIdentity'] & {
  readonly runtime?: 'claude' | 'pi';
};
export interface NormalBranchLaunchRequest {
  readonly invocation: NativeBranchInvocation;
  readonly branch: ImmutableBranchLaunch;
  readonly plan: ConversationBranchPlanV1;
}

/**
 * The branch transport deliberately owns no process construction.  It hands the
 * native fork argv and the immutable parent authority to the same launch path
 * used by an ordinary launch.  That path publishes projections, applies
 * executor admission and observes the runtime lifecycle event.
 */
export function createProductionSessionBranchRuntimeAdapter(dependencies: {
  executeNormalLaunch(request: NormalBranchLaunchRequest): Promise<BranchChildProcess>;
}) {
  return Object.freeze({
    launch(
      invocation: NativeBranchInvocation,
      plan: ConversationBranchPlanV1,
    ): Promise<BranchChildProcess> {
      return dependencies.executeNormalLaunch(
        Object.freeze({ invocation, branch: plan.launchIdentity, plan }),
      );
    },
  });
}

interface InspectedExecutable {
  readonly file: boolean;
  readonly realpath: string;
}
interface TerminalRunRequest extends TerminalTabPlan {
  readonly shell: false;
}
function canonical(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
async function defaultInspect(file: string): Promise<InspectedExecutable> {
  const named = await lstat(file);
  if (!named.isFile() || named.isSymbolicLink()) {
    return { file: false, realpath: file };
  }
  return { file: true, realpath: await realpath(file) };
}
async function trustedTerminal(input: {
  candidate?: string;
  trustedRoots: readonly string[];
  inspect?: (file: string) => Promise<InspectedExecutable>;
}): Promise<string | null> {
  if (
    !input.candidate ||
    !path.isAbsolute(input.candidate) ||
    path.basename(input.candidate).toLowerCase() !== 'wt.exe'
  ) {
    return null;
  }
  const inspected = await (input.inspect ?? defaultInspect)(input.candidate).catch(() => undefined);
  if (!inspected?.file || !path.isAbsolute(inspected.realpath)) {
    return null;
  }
  const real = canonical(inspected.realpath);
  return input.trustedRoots.some((root) => path.isAbsolute(root) && within(canonical(root), real))
    ? inspected.realpath
    : null;
}

/** Optional by design: absence is a diagnostic, never a fallback to a shell. */
export async function createWindowsTerminalBranchAdapter(input: {
  readonly candidate?: string;
  readonly trustedRoots: readonly string[];
  readonly inspect?: (file: string) => Promise<InspectedExecutable>;
  readonly run: (request: TerminalRunRequest) => Promise<BranchChildProcess>;
}) {
  const executable = await trustedTerminal(input);
  if (!executable) {
    return null;
  }
  return Object.freeze({
    async launch(plan: TerminalTabPlan): Promise<BranchChildProcess> {
      if (canonical(plan.executable) !== canonical(executable)) {
        throw Object.assign(new Error('Windows Terminal executable changed after planning.'), {
          code: 'SESSION_BRANCH_TERMINAL_MISMATCH',
        });
      }
      return input.run(
        Object.freeze({
          executable,
          argv: Object.freeze([...plan.argv]),
          cwd: plan.cwd,
          shell: false,
        }),
      );
    },
  });
}

export async function diagnoseSessionBranchAdapters(input: {
  readonly runtimeAvailable: boolean;
  readonly terminalCandidate?: string;
  readonly trustedRoots: readonly string[];
}) {
  const terminal = await trustedTerminal({
    ...(input.terminalCandidate ? { candidate: input.terminalCandidate } : {}),
    trustedRoots: input.trustedRoots,
  });
  return Object.freeze({
    runtime: Object.freeze(
      input.runtimeAvailable
        ? { available: true as const }
        : { available: false as const, code: 'SESSION_BRANCH_RUNTIME_UNAVAILABLE' as const },
    ),
    terminal: Object.freeze(
      terminal
        ? { available: true as const, executable: terminal }
        : { available: false as const, code: 'WINDOWS_TERMINAL_UNAVAILABLE' as const },
    ),
  });
}
