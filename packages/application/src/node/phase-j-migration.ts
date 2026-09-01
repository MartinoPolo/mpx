import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MpxError } from '@mpx/core';
import {
  MigrationApplicationService,
  type MigrationApplicationRequest,
} from '../migration-application-service.js';

const execFile = promisify(execFileCallback);
const OLD_REFERENCE =
  /(?:mpx-claude-code|mpx-pi|\/mp:|\/mp-gh:|\.worktree-hub\.json|\.mpx[\\/]kanbanflow\.json|statusline-projects\.json)/iu;
const PRIVATE_PATH =
  /(?:^|\/)(?:auth(?:\.json)?|credentials?(?:\.[^/]*)?|settings\.local\.json|sessions?|history|trust|\.env(?:\..*)?)(?:\/|$)/iu;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const portable = (value: string) => value.replaceAll('\\', '/');

type BaselineEntry = {
  source: string;
  path: string;
  sha256?: string | null;
  destination?: string | null;
  disposition?: string;
  reason?: string;
  evidence?: unknown[];
  completion?: string;
};
type Baseline = { sources?: { id: string; commit?: string }[]; entries: BaselineEntry[] };
type DriftEntry = {
  source: string;
  path: string;
  state: string;
  sha256: string | null;
  baselineSha256: string | null;
  privacy?: string;
  renamedFrom?: string;
  renamedTo?: string;
};

async function git(root: string, args: string[]): Promise<string> {
  return (
    await execFile('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
}
function nul(value: string): string[] {
  return value.split('\0').filter(Boolean).map(portable);
}
async function hashFile(file: string): Promise<string | null> {
  try {
    return sha(await readFile(file));
  } catch {
    return null;
  }
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}
function privacy(relative: string): string | undefined {
  return PRIVATE_PATH.test(portable(relative)) ? 'private-account-state' : undefined;
}

export async function captureSourceDrift(input: {
  baseline: Baseline;
  sources: { id: string; root: string; symbolicRoot: string }[];
}) {
  const entries: DriftEntry[] = [],
    sources = [];
  for (const source of input.sources) {
    const commit = (await git(source.root, ['rev-parse', 'HEAD'])).trim();
    const tracked = new Set(nul(await git(source.root, ['ls-files', '-z'])));
    const untracked = nul(
      await git(source.root, ['ls-files', '--others', '--exclude-standard', '-z']),
    );
    const status = nul(
      await git(source.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    );
    const states = new Map<string, { state: string; other?: string }>();
    for (let i = 0; i < status.length; i++) {
      const record = status[i]!;
      const code = record.slice(0, 2),
        first = portable(record.slice(3));
      if (code.includes('R')) {
        const second = status[++i];
        if (second) {
          states.set(first, { state: 'renamed', other: second });
          states.set(second, { state: 'renamed', other: first });
        }
        continue;
      }
      states.set(first, {
        state: code === '??' ? 'untracked' : code.includes('D') ? 'deleted' : 'modified',
      });
    }
    const baselineEntries = input.baseline.entries.filter((e) => e.source === source.id),
      baselineByPath = new Map(baselineEntries.map((e) => [e.path, e]));
    const paths = new Set([
      ...tracked,
      ...untracked,
      ...baselineEntries.map((e) => e.path),
      ...states.keys(),
    ]);
    for (const relative of [...paths].sort()) {
      const old = baselineByPath.get(relative),
        statusEntry = states.get(relative),
        excluded = privacy(relative) ?? (old?.disposition === 'excluded' ? old.reason : undefined);
      let state = excluded
        ? (await exists(path.join(source.root, relative)))
          ? 'excluded'
          : 'deleted'
        : (statusEntry?.state ??
          (tracked.has(relative) ? 'tracked' : old ? 'deleted' : 'untracked'));
      const currentHash =
        excluded || state === 'deleted' ? null : await hashFile(path.join(source.root, relative));
      if (state === 'tracked' && old?.sha256 && currentHash !== old.sha256) {
        state = 'changed-since-baseline';
      }
      const item: DriftEntry = {
        source: source.id,
        path: relative,
        state,
        sha256: currentHash,
        baselineSha256: old?.sha256 ?? null,
      };
      if (excluded) {
        item.privacy = excluded;
      }
      if (statusEntry?.state === 'renamed') {
        const other = statusEntry.other!;
        if (old) {
          item.renamedTo = other;
        } else {
          item.renamedFrom = other;
        }
      }
      entries.push(item);
    }
    sources.push({
      id: source.id,
      symbolicRoot: source.symbolicRoot,
      baselineCommit: input.baseline.sources?.find((s) => s.id === source.id)?.commit ?? null,
      currentCommit: commit,
      dirty: status.length > 0,
    });
  }
  const counts = Object.fromEntries(
    [...new Set(entries.map((e) => e.state))]
      .sort()
      .map((state) => [state, entries.filter((e) => e.state === state).length]),
  );
  return {
    schemaVersion: 1,
    kind: 'mpx-phase-j-source-drift',
    capturedAt: new Date().toISOString(),
    sources,
    counts,
    entries,
  };
}

export type ParityStatus = 'passed' | 'failed' | 'timed-out' | 'unavailable' | 'not-run';
export type ParityResult = {
  id: string;
  status: ParityStatus;
  exitCode: number | null;
  stdout: { bytes: number; digest: string };
  stderr: { bytes: number; digest: string };
};
type ParityDeclaration = {
  id: string;
  kind: 'node' | 'vitest';
  entry: string;
  entries?: readonly string[];
  buildFilters?: readonly string[];
};
const PARITY: readonly ParityDeclaration[] = [
  {
    id: 'semantic',
    kind: 'vitest',
    entry: 'tests/contract/providers/conformance.test.ts',
    entries: [
      'packages/skills/test/unit/canonical-content.test.ts',
      'tests/contract/providers/conformance.test.ts',
    ],
    buildFilters: ['@mpx/skills...', '@mpx/provider-github...'],
  },
  { id: 'generation', kind: 'node', entry: 'scripts/validate-generated.mjs' },
  { id: 'hooks', kind: 'vitest', entry: 'packages/runtime-hooks/test/unit/index.test.ts' },
  {
    id: 'tools',
    kind: 'vitest',
    entry: 'packages/runtime-tools/test/unit/runtime-tools.test.ts',
  },
  { id: 'status', kind: 'vitest', entry: 'packages/status/test/unit/status.test.ts' },
  { id: 'dependencies', kind: 'node', entry: 'scripts/required-convergence.mjs' },
];
const outputEvidence = (value: string) => ({
  bytes: Buffer.byteLength(value),
  digest: sha(Buffer.from(value).subarray(0, 64 * 1024)),
});
type ParityRunRequest = {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
};
type ParityRunResult = {
  status: 'passed' | 'failed' | 'timed-out';
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
async function defaultParityRunner(request: ParityRunRequest): Promise<ParityRunResult> {
  try {
    const result = await execFile(request.program, request.args, {
      cwd: request.cwd,
      env: request.env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 128 * 1024,
      timeout: request.timeoutMs,
    });
    return { status: 'passed', exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (failure) {
    const error = failure as NodeJS.ErrnoException & {
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    return {
      status: error.killed || error.code === 'ETIMEDOUT' ? 'timed-out' : 'failed',
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}
export async function executeParityChecks(input: {
  repoRoot: string;
  declarations?: readonly ParityDeclaration[];
  runner?: (request: ParityRunRequest) => Promise<ParityRunResult>;
  exists?: (file: string) => Promise<boolean>;
  perCheckTimeoutMs?: number;
  totalTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}): Promise<ParityResult[]> {
  if (!path.isAbsolute(input.repoRoot)) {
    throw new Error('Parity repository root must be absolute');
  }
  const declarations = input.declarations ?? PARITY,
    runner = input.runner ?? defaultParityRunner,
    existsFn =
      input.exists ??
      (async (file) => {
        try {
          return (await lstat(file)).isFile();
        } catch {
          return false;
        }
      }),
    started = Date.now(),
    total = input.totalTimeoutMs ?? 120_000,
    per = input.perCheckTimeoutMs ?? 20_000;
  const pnpmHome = input.environment?.PNPM_HOME ?? process.env.PNPM_HOME,
    narrowEnv: NodeJS.ProcessEnv = {
      PATH: input.environment?.PATH ?? process.env.PATH,
      PATHEXT: input.environment?.PATHEXT ?? process.env.PATHEXT,
      SystemRoot: input.environment?.SystemRoot ?? process.env.SystemRoot,
      ComSpec: input.environment?.ComSpec ?? process.env.ComSpec,
      TEMP: input.environment?.TEMP ?? process.env.TEMP,
      TMP: input.environment?.TMP ?? process.env.TMP,
      PNPM_HOME: pnpmHome,
      MPX_PROJECTS: input.environment?.MPX_PROJECTS,
      CI: '1',
      NO_COLOR: '1',
    };
  const vitest = path.join(input.repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    pnpm = pnpmHome
      ? path.join(path.resolve(pnpmHome), process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
      : undefined,
    results: ParityResult[] = [];
  for (const declaration of declarations) {
    const remaining = total - (Date.now() - started),
      entries = declaration.entries ?? [declaration.entry],
      resolvedEntries = entries.map((entry) => path.resolve(input.repoRoot, entry));
    if (remaining <= 0) {
      results.push({
        id: declaration.id,
        status: 'not-run',
        exitCode: null,
        stdout: outputEvidence(''),
        stderr: outputEvidence(''),
      });
      continue;
    }
    if (
      (await Promise.all(resolvedEntries.map(existsFn))).includes(false) ||
      (declaration.kind === 'vitest' && !(await existsFn(vitest))) ||
      (declaration.buildFilters !== undefined && (pnpm === undefined || !(await existsFn(pnpm))))
    ) {
      results.push({
        id: declaration.id,
        status: 'unavailable',
        exitCode: null,
        stdout: outputEvidence(''),
        stderr: outputEvidence(''),
      });
      continue;
    }
    let prerequisite: ParityRunResult | undefined;
    if (declaration.buildFilters !== undefined && pnpm !== undefined) {
      prerequisite = await runner({
        program: pnpm,
        args: [...declaration.buildFilters.flatMap((filter) => ['--filter', filter]), 'build'],
        cwd: input.repoRoot,
        env: narrowEnv,
        timeoutMs: Math.min(per, remaining),
      });
      if (prerequisite.status !== 'passed') {
        results.push({
          id: declaration.id,
          status: prerequisite.status,
          exitCode: prerequisite.exitCode,
          stdout: outputEvidence(prerequisite.stdout),
          stderr: outputEvidence(prerequisite.stderr),
        });
        continue;
      }
    }
    const postBuildRemaining = total - (Date.now() - started);
    if (postBuildRemaining <= 0) {
      results.push({
        id: declaration.id,
        status: 'timed-out',
        exitCode: null,
        stdout: outputEvidence(prerequisite?.stdout ?? ''),
        stderr: outputEvidence(prerequisite?.stderr ?? ''),
      });
      continue;
    }
    const args =
        declaration.kind === 'vitest'
          ? [vitest, 'run', ...entries, '--reporter=dot']
          : [resolvedEntries[0]!],
      outcome = await runner({
        program: process.execPath,
        args,
        cwd: input.repoRoot,
        env: narrowEnv,
        timeoutMs: Math.min(per, postBuildRemaining),
      });
    results.push({
      id: declaration.id,
      status: outcome.status,
      exitCode: outcome.exitCode,
      stdout: outputEvidence(`${prerequisite?.stdout ?? ''}${outcome.stdout}`),
      stderr: outputEvidence(`${prerequisite?.stderr ?? ''}${outcome.stderr}`),
    });
  }
  return results;
}
export function createParityReport(input: {
  baseline: Baseline;
  drift: { entries: DriftEntry[] };
  exceptions: { id: string; reason: string }[];
  parityResults?: ParityResult[];
}) {
  const drift = new Map(input.drift.entries.map((e) => [`${e.source}:${e.path}`, e]));
  const sourceEntries = input.baseline.entries.map((entry) => ({
    source: entry.source,
    path: entry.path,
    destination: entry.destination ?? null,
    disposition: entry.disposition ?? 'unclassified',
    completion: entry.completion ?? null,
    evidence: entry.evidence ?? [],
    currentDrift: drift.get(`${entry.source}:${entry.path}`)?.state ?? 'not-captured',
  }));
  const incomplete = sourceEntries.filter(
      (entry) => entry.disposition === 'unclassified' || entry.evidence.length === 0,
    ),
    parity =
      input.parityResults ??
      PARITY.map((item) => ({
        id: item.id,
        status: 'not-run' as const,
        exitCode: null,
        stdout: outputEvidence(''),
        stderr: outputEvidence(''),
      }));
  const ids = new Set(parity.map((item) => item.id)),
    requiredIds = PARITY.map((item) => item.id),
    parityComplete =
      parity.length === requiredIds.length &&
      ids.size === parity.length &&
      requiredIds.every((id) => ids.has(id)) &&
      parity.every((item) => item.status === 'passed');
  const passed = input.exceptions.length === 0 && incomplete.length === 0 && parityComplete;
  return {
    schemaVersion: 1,
    kind: 'mpx-phase-j-parity-report',
    sourceEntries,
    parity,
    exceptions: input.exceptions,
    gate: {
      passed,
      exceptionCount: input.exceptions.length,
      incompleteSourceCount: incomplete.length,
      parityPassed: parityComplete,
      requiresExplicitZeroExceptions: true,
    },
  };
}

type AuditFinding = {
  surface: 'log' | 'process' | 'environment' | 'projection';
  reference: string;
  matchDigest: string;
};
function auditFail(code: string, message: string, cause?: unknown): never {
  throw new MpxError({ code, message, ...(cause === undefined ? {} : { cause }) });
}
function sameEntry(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
function sameFileSnapshot(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    sameEntry(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
async function scanFiles(
  root: string,
  findings: AuditFinding[],
  surface: 'log' | 'projection',
): Promise<'observed' | 'missing'> {
  if (!path.isAbsolute(root)) {
    auditFail('MIGRATION_AUDIT_ROOT_INVALID', 'Migration audit roots must be absolute.');
  }
  const absoluteRoot = path.resolve(root);
  try {
    await lstat(absoluteRoot);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    auditFail(
      'MIGRATION_AUDIT_OPENDIR_FAILED',
      'Migration audit directory cannot be inspected.',
      failure,
    );
  }
  async function walk(dir: string): Promise<void> {
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(dir);
    } catch (failure) {
      auditFail(
        'MIGRATION_AUDIT_OPENDIR_FAILED',
        'Migration audit directory cannot be inspected.',
        failure,
      );
    }
    if (before.isSymbolicLink()) {
      auditFail('MIGRATION_AUDIT_SYMLINK', 'Migration audit refuses symbolic links.');
    }
    if (!before.isDirectory()) {
      auditFail('MIGRATION_AUDIT_OPENDIR_FAILED', 'Migration audit root is not a directory.');
    }
    let handle;
    try {
      handle = await opendir(dir);
    } catch (failure) {
      auditFail(
        'MIGRATION_AUDIT_OPENDIR_FAILED',
        'Migration audit directory cannot be opened.',
        failure,
      );
    }
    try {
      const after = await lstat(dir);
      if (!sameEntry(before, after)) {
        auditFail(
          'MIGRATION_AUDIT_PATH_REPLACED',
          'Migration audit directory changed during inspection.',
        );
      }
    } catch (failure) {
      if (failure instanceof MpxError) {
        throw failure;
      }
      auditFail(
        'MIGRATION_AUDIT_PATH_REPLACED',
        'Migration audit directory changed during inspection.',
        failure,
      );
    }
    for await (const entry of handle) {
      const file = path.join(dir, entry.name),
        relative = portable(path.relative(absoluteRoot, file));
      if (relative.startsWith('../') || path.isAbsolute(relative)) {
        auditFail('MIGRATION_AUDIT_PATH_ESCAPE', 'Migration audit entry escaped its root.');
      }
      let fileBefore: Awaited<ReturnType<typeof lstat>>;
      try {
        fileBefore = await lstat(file);
      } catch (failure) {
        auditFail(
          'MIGRATION_AUDIT_PATH_REPLACED',
          'Migration audit entry changed during inspection.',
          failure,
        );
      }
      if (fileBefore.isSymbolicLink()) {
        auditFail('MIGRATION_AUDIT_SYMLINK', 'Migration audit refuses symbolic links.');
      }
      if (PRIVATE_PATH.test(relative)) {
        continue;
      }
      if (fileBefore.isDirectory()) {
        if (!['.git', 'node_modules', 'dist'].includes(entry.name)) {
          await walk(file);
        }
        continue;
      }
      if (!fileBefore.isFile()) {
        auditFail('MIGRATION_AUDIT_FILE_INVALID', 'Migration audit accepts regular files only.');
      }
      let fileHandle;
      try {
        fileHandle = await open(file, 'r');
      } catch (failure) {
        auditFail('MIGRATION_AUDIT_READ_FAILED', 'Migration audit file cannot be opened.', failure);
      }
      try {
        const opened = await fileHandle.stat();
        if (!opened.isFile() || !sameEntry(fileBefore, opened)) {
          auditFail(
            'MIGRATION_AUDIT_PATH_REPLACED',
            'Migration audit file changed during inspection.',
          );
        }
        if (opened.size > 2_000_000) {
          auditFail(
            'MIGRATION_AUDIT_FILE_TOO_LARGE',
            'Migration audit file exceeds the read-only observation bound.',
          );
        }
        let body: string;
        try {
          body = await fileHandle.readFile('utf8');
        } catch (failure) {
          auditFail('MIGRATION_AUDIT_READ_FAILED', 'Migration audit file cannot be read.', failure);
        }
        const final = await fileHandle.stat();
        if (!sameFileSnapshot(opened, final)) {
          auditFail(
            'MIGRATION_AUDIT_PATH_REPLACED',
            'Migration audit file changed during inspection.',
          );
        }
        if (OLD_REFERENCE.test(body)) {
          findings.push({
            surface,
            reference: sha(relative).slice(0, 16),
            matchDigest: sha(body.match(OLD_REFERENCE)?.[0]?.toLowerCase() ?? 'match'),
          });
        }
      } finally {
        await fileHandle.close();
      }
    }
  }
  await walk(absoluteRoot);
  return 'observed';
}
const ROUTE_PROJECTION_KEYS = [
  ['claude-personal', 'MPX_CLAUDE_PERSONAL_PROJECTION_ROOT'],
  ['claude-work', 'MPX_CLAUDE_WORK_PROJECTION_ROOT'],
  ['pi-personal', 'MPX_PI_PERSONAL_PROJECTION_ROOT'],
  ['pi-work', 'MPX_PI_WORK_PROJECTION_ROOT'],
] as const;
type ProjectionRoot =
  | { route: (typeof ROUTE_PROJECTION_KEYS)[number][0]; status: 'configured'; root: string }
  | { route: (typeof ROUTE_PROJECTION_KEYS)[number][0]; status: 'unconfigured' };
export function migrationProjectionRoots(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ProjectionRoot[] {
  const roots = ROUTE_PROJECTION_KEYS.map(([route, key]) => {
      const value = environment[key];
      if (!value) {
        return { route, status: 'unconfigured' } as const;
      }
      if (!path.isAbsolute(value)) {
        auditFail('MIGRATION_AUDIT_ROOT_INVALID', `${key} must be absolute.`);
      }
      return { route, status: 'configured', root: path.resolve(value) } as const;
    }),
    seen = new Set<string>();
  for (const item of roots) {
    if (item.status !== 'configured') {
      continue;
    }
    const identity = process.platform === 'win32' ? item.root.toLowerCase() : item.root;
    if (seen.has(identity)) {
      auditFail(
        'MIGRATION_AUDIT_ROOT_DUPLICATE',
        'Migration projection routes must have distinct roots.',
      );
    }
    seen.add(identity);
  }
  return roots;
}
type LogRoot = string | { label: string; root: string };
export async function runtimeAccessAudit(input: {
  roots: LogRoot[];
  projectionRoots?: ProjectionRoot[] | string[];
  processLines?: string[];
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  legacyDisabled?: boolean;
}) {
  const findings: AuditFinding[] = [],
    targets: {
      surface: 'log' | 'projection';
      label: string;
      status: 'observed' | 'missing' | 'unconfigured';
    }[] = [];
  for (const [index, item] of input.roots.entries()) {
    const root = typeof item === 'string' ? item : item.root,
      label = typeof item === 'string' ? `log-${index}` : item.label;
    targets.push({ surface: 'log', label, status: await scanFiles(root, findings, 'log') });
  }
  for (const [index, item] of (input.projectionRoots ?? []).entries()) {
    if (typeof item === 'string') {
      targets.push({
        surface: 'projection',
        label: `projection-${index}`,
        status: await scanFiles(item, findings, 'projection'),
      });
      continue;
    }
    if (item.status === 'unconfigured') {
      targets.push({ surface: 'projection', label: item.route, status: 'unconfigured' });
      continue;
    }
    targets.push({
      surface: 'projection',
      label: item.route,
      status: await scanFiles(item.root, findings, 'projection'),
    });
  }
  for (const [index, line] of (input.processLines ?? []).entries()) {
    if (OLD_REFERENCE.test(line)) {
      findings.push({
        surface: 'process',
        reference: `process-${index}`,
        matchDigest: sha(line.match(OLD_REFERENCE)?.[0]?.toLowerCase() ?? 'match'),
      });
    }
  }
  for (const [name, value] of Object.entries(input.environment ?? {})) {
    if (value && OLD_REFERENCE.test(value)) {
      findings.push({
        surface: 'environment',
        reference: name.startsWith('MPX_') ? name : 'redacted-env',
        matchDigest: sha(value.match(OLD_REFERENCE)?.[0]?.toLowerCase() ?? 'match'),
      });
    }
  }
  const mode = input.legacyDisabled ? 'legacy-disabled' : 'observation',
    allObserved = targets.every((item) => item.status === 'observed');
  return {
    schemaVersion: 1,
    kind: 'mpx-phase-j-runtime-access-audit',
    readOnly: true,
    credentialContentCaptured: false,
    targets,
    findings,
    acceptance: {
      mode,
      passed: input.legacyDisabled === true && findings.length === 0 && allObserved,
      requiresLegacyDisabledFixture: true,
      allTargetsObserved: allObserved,
    },
  };
}

export type MarkerInspection = {
  label: string;
  status: 'exact' | 'absent' | 'malformed' | 'inaccessible' | 'race';
  contentDigest?: string;
};
export async function inspectOwnedActivation(input: {
  file: string;
  label: string;
  startMarker: string;
  endMarker: string;
  hooks?: { afterOpen?: () => Promise<void> };
}): Promise<MarkerInspection> {
  if (!path.isAbsolute(input.file)) {
    throw new Error('Owned activation path must resolve to an absolute path');
  }
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(input.file);
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { label: input.label, status: 'absent' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { label: input.label, status: 'inaccessible' };
    }
    throw failure;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    return { label: input.label, status: 'inaccessible' };
  }
  let handle;
  try {
    handle = await open(input.file, 'r');
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { label: input.label, status: 'race' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { label: input.label, status: 'inaccessible' };
    }
    throw failure;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameEntry(before, opened)) {
      return { label: input.label, status: 'race' };
    }
    await input.hooks?.afterOpen?.();
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return { label: input.label, status: 'inaccessible' };
      }
      throw failure;
    }
    if (bytes.length > 2_000_000) {
      return { label: input.label, status: 'malformed', contentDigest: sha(bytes) };
    }
    const final = await handle.stat();
    if (!sameFileSnapshot(opened, final)) {
      return { label: input.label, status: 'race' };
    }
    const content = bytes.toString('utf8'),
      start = content.indexOf(input.startMarker),
      end = content.indexOf(input.endMarker, start + input.startMarker.length),
      exact =
        start >= 0 &&
        end >= 0 &&
        content.indexOf(input.startMarker, start + 1) < 0 &&
        content.indexOf(input.endMarker, end + 1) < 0;
    return { label: input.label, status: exact ? 'exact' : 'malformed', contentDigest: sha(bytes) };
  } finally {
    await handle.close();
  }
}
function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => [key, normalize(val)]),
          )
        : item;
  return `${JSON.stringify(normalize(value))}\n`;
}
export async function persistMigrationObservation(input: {
  localAppData: string;
  evidence: unknown;
  hooks?: { beforePublish?: () => void | Promise<void>; afterPublish?: () => void | Promise<void> };
}) {
  if (!path.isAbsolute(input.localAppData)) {
    auditFail('MIGRATION_OBSERVATION_ROOT_INVALID', 'LOCALAPPDATA must be absolute.');
  }
  const base = path.resolve(input.localAppData),
    mpx = path.join(base, 'mpx'),
    directory = path.join(mpx, 'migration-observations'),
    ensureDirectory = async (candidate: string, create: boolean) => {
      try {
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          auditFail('MIGRATION_OBSERVATION_UNSAFE', 'Migration observation storage is unsafe.');
        }
      } catch (failure) {
        if (failure instanceof MpxError) {
          throw failure;
        }
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT' || !create) {
          throw failure;
        }
        await mkdir(candidate, { mode: 0o700 });
        const created = await lstat(candidate);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          auditFail(
            'MIGRATION_OBSERVATION_UNSAFE',
            'Migration observation storage changed during creation.',
          );
        }
      }
    };
  await ensureDirectory(base, false);
  await ensureDirectory(mpx, true);
  await ensureDirectory(directory, true);
  type Anchor = {
    stats: Awaited<ReturnType<typeof lstat>>[];
    baseReal: string;
    directoryReal: string;
  };
  const anchor = async (): Promise<Anchor> => {
    const stats = [];
    for (const candidate of [base, mpx, directory]) {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        auditFail('MIGRATION_OBSERVATION_UNSAFE', 'Migration observation ancestor is unsafe.');
      }
      stats.push(stat);
    }
    const [baseReal, directoryReal] = await Promise.all([realpath(base), realpath(directory)]),
      relative = path.relative(baseReal, directoryReal);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      auditFail(
        'MIGRATION_OBSERVATION_UNSAFE',
        'Migration observation storage escapes LOCALAPPDATA.',
      );
    }
    return { stats, baseReal, directoryReal };
  };
  const sameAnchor = (left: Anchor, right: Anchor) =>
    left.baseReal === right.baseReal &&
    left.directoryReal === right.directoryReal &&
    left.stats.every((stat, index) => sameEntry(stat, right.stats[index]!));
  const bytes = Buffer.from(canonicalJson(input.evidence));
  if (bytes.length > 8 * 1024 * 1024) {
    auditFail('MIGRATION_OBSERVATION_TOO_LARGE', 'Migration observation exceeds its bounded size.');
  }
  const digest = sha(bytes),
    file = path.join(directory, `${digest}.json`);
  const verifyExisting = async (disposition: 'created' | 'reused', beforeAnchor: Anchor) => {
    let handle;
    try {
      handle = await open(file, 'r');
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== bytes.length) {
        auditFail('MIGRATION_OBSERVATION_COLLISION', 'Migration observation collision detected.');
      }
      const existing = await handle.readFile(),
        final = await handle.stat();
      if (!sameFileSnapshot(opened, final) || !existing.equals(bytes)) {
        auditFail(
          'MIGRATION_OBSERVATION_COLLISION',
          'Migration observation digest collision or race detected.',
        );
      }
    } catch (failure) {
      if (failure instanceof MpxError) {
        throw failure;
      }
      auditFail(
        'MIGRATION_OBSERVATION_UNSAFE',
        'Migration observation publication is unsafe.',
        failure,
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const afterAnchor = await anchor();
    if (!sameAnchor(beforeAnchor, afterAnchor)) {
      auditFail(
        'MIGRATION_OBSERVATION_UNSAFE',
        'Migration observation ancestors changed during publication.',
      );
    }
    return {
      schemaVersion: 1,
      kind: 'mpx-migration-observation',
      digest,
      disposition,
      storage: 'localappdata/migration-observations',
    };
  };
  const initial = await anchor();
  try {
    await lstat(file);
    return await verifyExisting('reused', initial);
  } catch (failure) {
    if (failure instanceof MpxError) {
      throw failure;
    }
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw failure;
    }
  }
  const temporary = path.join(
    directory,
    `.${digest}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let temporarySafe = true;
  try {
    const handle = await open(temporary, 'wx', 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      const complete = await handle.stat();
      if (!complete.isFile() || complete.size !== bytes.length) {
        auditFail(
          'MIGRATION_OBSERVATION_VERIFY_FAILED',
          'Migration observation temporary file is incomplete.',
        );
      }
    } finally {
      await handle.close();
    }
    await input.hooks?.beforePublish?.();
    const beforePublish = await anchor();
    if (!sameAnchor(initial, beforePublish)) {
      temporarySafe = false;
      auditFail(
        'MIGRATION_OBSERVATION_UNSAFE',
        'Migration observation ancestors changed before publication.',
      );
    }
    try {
      await link(temporary, file);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw failure;
      }
      return await verifyExisting('reused', beforePublish);
    }
    await input.hooks?.afterPublish?.();
    const result = await verifyExisting('created', beforePublish),
      afterPublish = await anchor();
    if (!sameAnchor(beforePublish, afterPublish)) {
      auditFail(
        'MIGRATION_OBSERVATION_UNSAFE',
        'Migration observation ancestors changed after publication.',
      );
    }
    return result;
  } finally {
    if (temporarySafe) {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
export function buildCutoverPlan(input: {
  gatePassed: boolean;
  ownedActivations?: { path: string; startMarker: string; endMarker: string; content: string }[];
  markerInspections?: MarkerInspection[];
}) {
  const inspections =
    input.markerInspections ??
    (input.ownedActivations ?? []).map((item) => {
      const start = item.content.indexOf(item.startMarker),
        end = item.content.indexOf(item.endMarker, start + item.startMarker.length),
        exact =
          start >= 0 &&
          end >= 0 &&
          item.content.indexOf(item.startMarker, start + 1) < 0 &&
          item.content.indexOf(item.endMarker, end + 1) < 0;
      return {
        label: item.path,
        status: exact ? ('exact' as const) : ('malformed' as const),
        contentDigest: sha(item.content),
      };
    });
  const effectiveGate = input.gatePassed && inspections.every((item) => item.status === 'exact'),
    actions = inspections.map((item) => ({
      kind: 'remove-owned-marker-block',
      label: item.label,
      markerStatus: item.status,
      contentDigest: item.contentDigest ?? null,
      exactOwnedMatch: item.status === 'exact',
      eligible: input.gatePassed && item.status === 'exact',
    }));
  const core = {
    schemaVersion: 1,
    kind: 'mpx-phase-j-cutover-plan',
    nonDestructive: true,
    gatePassed: effectiveGate,
    actions,
    manualOnly: [
      {
        kind: 'archive',
        targets: ['${MPX_PROJECTS}/mpx-pi', '${MPX_PROJECTS}/mpx-claude-code'],
        requires: 'complete provenance, zero runtime references, and human provider action',
      },
      {
        kind: 'rename',
        targets: ['${MPX_PROJECTS}/mpx-pi', '${MPX_PROJECTS}/mpx-claude-code'],
        requires: 'human filesystem action after rollback window',
      },
      {
        kind: 'remotes',
        targets: ['legacy repository remotes and redirects'],
        requires: 'human provider and Git action',
      },
    ],
    prohibitions: [
      'delete-native-state',
      'disable-live-legacy',
      'archive-repository',
      'change-remotes',
      'apply-cutover',
    ],
  };
  return { ...core, confirmationDigest: sha(canonicalJson(core)) };
}
function removeExact(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker),
    markerEnd = content.indexOf(endMarker, start + startMarker.length);
  if (
    start < 0 ||
    markerEnd < 0 ||
    content.indexOf(startMarker, start + 1) >= 0 ||
    content.indexOf(endMarker, markerEnd + 1) >= 0
  ) {
    throw new Error('owned activation markers are not an exact unique pair');
  }
  let end = markerEnd + endMarker.length;
  if (content[end] === '\r') {
    end++;
  }
  if (content[end] === '\n') {
    end++;
  }
  return content.slice(0, start) + content.slice(end);
}
export async function rollbackDrill(input: {
  content: string;
  startMarker: string;
  endMarker: string;
  now?: Date;
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-rollback-drill-'));
  try {
    const file = path.join(root, 'profile'),
      snapshot = Buffer.from(input.content),
      digest = sha(snapshot),
      snapshotFile = path.join(root, `${digest}.snapshot`);
    await writeFile(snapshotFile, snapshot, { flag: 'wx', mode: 0o400 });
    await writeFile(file, snapshot, { flag: 'wx' });
    const cutover = removeExact(input.content, input.startMarker, input.endMarker);
    await writeFile(file, cutover);
    await writeFile(file, await readFile(snapshotFile));
    const restoredDigest = sha(await readFile(file));
    const now = input.now ?? new Date(),
      expiresAt = new Date(now.getTime() + 30 * 86400_000).toISOString();
    return {
      schemaVersion: 1,
      kind: 'mpx-phase-j-rollback-drill',
      simulationRoot: 'temporary',
      realStateTouched: false,
      passed: restoredDigest === digest,
      snapshot: {
        immutable: true,
        digest,
        createdAt: now.toISOString(),
        retentionDays: 30,
        expiresAt,
      },
      cutoverDigest: sha(cutover),
      restoredDigest,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export function parseProcessCommandLines(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Windows process audit returned invalid command-line JSON');
  }
  return value;
}
export async function processCommandLines(
  snapshotJson?: string,
  runner: typeof execFile = execFile,
): Promise<string[]> {
  if (snapshotJson !== undefined) {
    if (Buffer.byteLength(snapshotJson, 'utf8') > 8 * 1024 * 1024) {
      throw new Error('MPX_MIGRATION_PROCESS_SNAPSHOT must be bounded to 8 MiB');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshotJson);
    } catch {
      throw new Error(
        'MPX_MIGRATION_PROCESS_SNAPSHOT must be an inline JSON array of command lines',
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length > 100_000 ||
      !parsed.every(
        (item) => typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= 64 * 1024,
      )
    ) {
      throw new Error(
        'MPX_MIGRATION_PROCESS_SNAPSHOT must be a bounded inline JSON array of command lines',
      );
    }
    return parsed;
  }
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const script =
      'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress';
    const output = (
      await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
      })
    ).stdout;
    return parseProcessCommandLines(JSON.parse(output || '[]') as unknown);
  } catch (failure) {
    throw new Error(
      'Windows process audit is unavailable; migration acceptance cannot be evaluated',
      { cause: failure },
    );
  }
}
function resolveSymbolic(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/^\$\{([^}]+)\}/u, (_, name: string) => env[name] ?? `\${${name}}`);
}
async function optionalJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return await loadJson<T>(file);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw failure;
  }
}
type OwnedActivation = { path: string; startMarker: string; endMarker: string };

export function parseOwnedActivations(value: unknown, env: NodeJS.ProcessEnv): OwnedActivation[] {
  const invalid = (detail: string): never => {
    throw new Error(`phase-j-owned-activations.json ${detail}`);
  };
  if (!Array.isArray(value) || value.length === 0) {
    return invalid('must contain a non-empty array');
  }
  const records = value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'endMarker,path,startMarker'
    ) {
      return invalid('contains an invalid activation record');
    }
    const { path: activationPath, startMarker, endMarker } = item as Record<string, unknown>;
    if (
      typeof activationPath !== 'string' ||
      activationPath.trim().length === 0 ||
      typeof startMarker !== 'string' ||
      startMarker.trim().length === 0 ||
      typeof endMarker !== 'string' ||
      endMarker.trim().length === 0
    ) {
      return invalid('contains a blank activation field');
    }
    const resolved = resolveSymbolic(activationPath, env);
    if (resolved.includes('${') || !path.isAbsolute(resolved)) {
      return invalid(`contains an unresolved path: ${activationPath}`);
    }
    return { path: activationPath, startMarker, endMarker };
  });
  const identities = records.map((record) => {
    const resolvedPath = path.resolve(resolveSymbolic(record.path, env));
    const canonicalPath = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    return JSON.stringify([canonicalPath, record.startMarker, record.endMarker]);
  });
  if (new Set(identities).size !== identities.length) {
    return invalid('contains duplicate activation records');
  }
  return records;
}

function parseExceptions(value: unknown): { id: string; reason: string }[] {
  if (!Array.isArray(value)) {
    throw new Error('phase-j-exceptions.json must contain an array');
  }
  const result = value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'id,reason'
    ) {
      throw new Error('phase-j-exceptions.json contains an invalid exception');
    }
    const { id, reason } = item as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      id.trim().length === 0 ||
      typeof reason !== 'string' ||
      reason.trim().length === 0
    ) {
      throw new Error('phase-j-exceptions.json contains an invalid exception');
    }
    return { id, reason };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length) {
    throw new Error('phase-j-exceptions.json contains duplicate IDs');
  }
  return result;
}
export async function executeMigrationCommand(input: {
  action: string;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  legacyDisabled: boolean;
  parityChecks?: () => Promise<ParityResult[]>;
}) {
  const baselineFile = path.join(input.repoRoot, 'docs', 'history', 'CONVERGENCE_MANIFEST.json');
  const baseline = await loadJson<Baseline>(baselineFile),
    projects = input.env.MPX_PROJECTS;
  if (!projects) {
    throw new Error('MPX_PROJECTS is required for migration source reconciliation');
  }
  const sourceSpecs = [
    {
      id: 'claude',
      root: path.join(projects, 'mpx-claude-code'),
      symbolicRoot: '${MPX_PROJECTS}/mpx-claude-code',
    },
    { id: 'pi', root: path.join(projects, 'mpx-pi'), symbolicRoot: '${MPX_PROJECTS}/mpx-pi' },
  ];
  if (input.action === 'rollback-drill') {
    return rollbackDrill({
      content: 'native\n# >>> old-mpx owned >>>\nlegacy\n# <<< old-mpx owned <<<\n',
      startMarker: '# >>> old-mpx owned >>>',
      endMarker: '# <<< old-mpx owned <<<',
    });
  }
  let ownedActivations: OwnedActivation[] | undefined;
  if (input.action === 'cutover-plan') {
    const manifest = path.join(input.repoRoot, 'docs', 'phase-j-owned-activations.json');
    let value: unknown;
    try {
      value = await loadJson<unknown>(manifest);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('phase-j-owned-activations.json is required', { cause: failure });
      }
      throw new Error('phase-j-owned-activations.json is malformed', { cause: failure });
    }
    ownedActivations = parseOwnedActivations(value, input.env);
  }
  const drift = await captureSourceDrift({ baseline, sources: sourceSpecs });
  const exceptions = parseExceptions(
      await optionalJson<unknown>(path.join(input.repoRoot, 'docs', 'phase-j-exceptions.json'), []),
    ),
    parityResults = await (input.parityChecks?.() ??
      executeParityChecks({ repoRoot: input.repoRoot, environment: input.env })),
    report = createParityReport({ baseline, drift, exceptions, parityResults });
  const auditRoots: LogRoot[] = [];
  if (input.env.APPDATA) {
    auditRoots.push({ label: 'appdata-logs', root: path.join(input.env.APPDATA, 'mpx', 'logs') });
  } else {
    auditFail('MIGRATION_AUDIT_ROOT_INVALID', 'APPDATA is required for migration audit.');
  }
  if (input.env.LOCALAPPDATA) {
    auditRoots.push({
      label: 'localappdata-logs',
      root: path.join(input.env.LOCALAPPDATA, 'mpx', 'logs'),
    });
  } else {
    auditFail(
      'MIGRATION_AUDIT_ROOT_INVALID',
      'LOCALAPPDATA is required for migration audit and observation retention.',
    );
  }
  const installedProjections = migrationProjectionRoots(input.env);
  const audit = await runtimeAccessAudit({
    roots: auditRoots,
    projectionRoots: installedProjections,
    processLines: await processCommandLines(input.env.MPX_MIGRATION_PROCESS_SNAPSHOT),
    environment: input.env,
    legacyDisabled: input.legacyDisabled,
  });
  const liveGatePassed = report.gate.passed && audit.acceptance.passed,
    stableDrift = { ...drift, capturedAt: undefined };
  const observation = await persistMigrationObservation({
    localAppData: input.env.LOCALAPPDATA,
    evidence: {
      schemaVersion: 1,
      kind: 'mpx-phase-j-combined-observation',
      sourceDrift: stableDrift,
      parity: report,
      runtimeAccessAudit: audit,
      gate: { passed: liveGatePassed },
    },
  });
  if (input.action === 'reconcile') {
    return {
      schemaVersion: 1,
      kind: 'mpx-migration-reconciliation',
      sourceDrift: drift,
      parity: report.parity,
      runtimeAccessAudit: audit,
      observation,
      gate: { passed: liveGatePassed },
    };
  }
  if (input.action === 'report') {
    return {
      ...report,
      sourceDriftSummary: drift.counts,
      runtimeAccessAudit: audit,
      observation,
      gate: {
        ...report.gate,
        passed: liveGatePassed,
        legacyDisabledAccepted: audit.acceptance.passed,
      },
    };
  }
  if (input.action === 'cutover-plan') {
    const markerInspections: MarkerInspection[] = [];
    for (const [index, spec] of ownedActivations!.entries()) {
      const file = resolveSymbolic(spec.path, input.env);
      if (file.includes('${')) {
        markerInspections.push({ label: `activation-${index}`, status: 'inaccessible' });
      } else {
        markerInspections.push(
          await inspectOwnedActivation({
            file: path.resolve(file),
            label: `activation-${index}`,
            startMarker: spec.startMarker,
            endMarker: spec.endMarker,
          }),
        );
      }
    }
    return { ...buildCutoverPlan({ gatePassed: liveGatePassed, markerInspections }), observation };
  }
  throw new Error(`Unknown migration action: ${input.action}`);
}

/** Composes the neutral migration facade with the complete Node Phase-J workflow. */
export function createNodeMigrationApplicationService(): MigrationApplicationService {
  return new MigrationApplicationService({
    execute: (request: MigrationApplicationRequest) =>
      executeMigrationCommand({ ...request, env: { ...request.env } }),
  });
}
