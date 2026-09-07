import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { NativeSessionRefV1, RuntimeName } from '@mpx/runtime-contracts';
import { SessionStore } from './store.js';
import {
  SessionError,
  parseSessionRecordV1,
  stableDigest,
  type IdentityV1,
  type LaunchSnapshotV1,
  type SessionRecordV1,
} from './schemas.js';

export interface ConfiguredNativeRoot {
  readonly root: string;
  readonly canonicalRootDigest: string;
  readonly identity: IdentityV1;
  readonly runtime: RuntimeName;
}
export interface ResumeDependencies {
  resolveConfiguredRoot(nativeBindingRef: string): Promise<ConfiguredNativeRoot>;
  verifyNativeTarget(
    root: string,
    ref: NativeSessionRefV1,
    runtimeQualifiedId: string,
  ): Promise<{ valid: boolean; activity: 'active' | 'inactive' | 'unavailable' }>;
}
export interface NativeVerifiedResumeSeedV1 {
  readonly schemaVersion: 1;
  /** Resume is always a visible relaunch with fresh approval/audit evidence. */
  readonly newLaunchRequired: true;
  readonly previousLaunch: Readonly<{ launchKey: string; descriptorDigest: string }>;
  readonly recordId: string;
  readonly runtimeQualifiedId: string;
  readonly runtime: RuntimeName;
  readonly identity: IdentityV1;
  readonly nativeBindingRef: string;
  readonly nativeSessionRef: NativeSessionRefV1;
  readonly nativeVerificationDigest: string;
  readonly cwd: string;
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  readonly launch: LaunchSnapshotV1;
}

export interface HistoricalResumePlanV1 extends NativeVerifiedResumeSeedV1 {
  readonly confirmationDigest: string;
}

export interface ResumeApprovalV1 {
  readonly schemaVersion: 1;
  readonly selectedConfigDigest: string;
  readonly recordedLaunchDigest: string;
  readonly resurrection: 'unchanged' | 'confirmation-required';
}

export interface ResumePlanV1 extends HistoricalResumePlanV1 {
  readonly approval: ResumeApprovalV1;
}

async function verifyPiHeader(root: string, record: SessionRecordV1): Promise<string> {
  const invalid = () =>
    new SessionError(
      'SESSION_RESUME_NATIVE_TARGET_INVALID',
      'The native Pi session header or file binding differs from the recorded session.',
    );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (record.nativeSessionRef.kind !== 'root-relative-file') {
      throw invalid();
    }
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw invalid();
    }
    const canonicalRoot = await realpath(root);
    const file = path.join(canonicalRoot, ...record.nativeSessionRef.value.split('/'));
    handle = await open(file, 'r');
    const opened = await handle.stat();
    const named = await lstat(file);
    const relative = path.relative(canonicalRoot, await realpath(file));
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw invalid();
    }
    const maximumHeaderBytes = 64 * 1024;
    const bytes = Buffer.alloc(maximumHeaderBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(10);
    if (newline < 0 || newline > maximumHeaderBytes) {
      throw invalid();
    }
    const header: unknown = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
    if (header === null || typeof header !== 'object' || Array.isArray(header)) {
      throw invalid();
    }
    const fields = header as { type?: unknown; version?: unknown; id?: unknown; cwd?: unknown };
    const normalizedPath = (value: string) =>
      process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
    if (
      fields.type !== 'session' ||
      fields.version !== 3 ||
      fields.id !== record.runtimeQualifiedId.slice('pi:'.length) ||
      typeof fields.cwd !== 'string' ||
      !path.isAbsolute(fields.cwd) ||
      normalizedPath(fields.cwd) !== normalizedPath(record.location.cwd)
    ) {
      throw invalid();
    }
    return stableDigest(header);
  } catch {
    throw invalid();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function verifyNativeResumeSeed(
  store: SessionStore,
  input: SessionRecordV1,
  dependencies: ResumeDependencies,
): Promise<NativeVerifiedResumeSeedV1> {
  const record = parseSessionRecordV1(input);
  if (record.launch === null) {
    throw new SessionError(
      'SESSION_RESUME_LAUNCH_UNBOUND',
      'session has no recorded launch snapshot',
    );
  }
  const recorded = await store.readNativeBinding(record.nativeBindingRef);
  if (
    recorded.identity.domain !== record.identity.domain ||
    recorded.identity.name !== record.identity.name ||
    recorded.runtime !== record.runtime
  ) {
    throw new SessionError(
      'SESSION_RESUME_BINDING_MISMATCH',
      'record and native binding identity/runtime differ',
    );
  }
  const configured = await dependencies.resolveConfiguredRoot(record.nativeBindingRef);
  if (
    configured.identity.domain !== recorded.identity.domain ||
    configured.identity.name !== recorded.identity.name ||
    configured.runtime !== recorded.runtime
  ) {
    throw new SessionError(
      'SESSION_RESUME_IDENTITY_MISMATCH',
      'configured identity/runtime differs from recorded binding',
    );
  }
  if (configured.canonicalRootDigest !== recorded.recordedRootDigest) {
    throw new SessionError(
      'SESSION_RESUME_ROOT_MISMATCH',
      'configured canonical root digest differs from recorded digest',
    );
  }
  const target = await dependencies.verifyNativeTarget(
    configured.root,
    record.nativeSessionRef,
    record.runtimeQualifiedId,
  );
  if (!target.valid) {
    throw new SessionError(
      'SESSION_RESUME_NATIVE_TARGET_INVALID',
      'native session id/file is missing, unsafe, or outside its recorded root',
    );
  }
  if (target.activity === 'unavailable') {
    throw new SessionError(
      'SESSION_RESUME_ACTIVITY_UNAVAILABLE',
      'native session activity could not be inspected',
    );
  }
  if (target.activity === 'active') {
    throw new SessionError('SESSION_RESUME_ACTIVE', 'native session is still active');
  }
  const headerDigest =
    record.runtime === 'pi' ? await verifyPiHeader(configured.root, record) : null;
  const unsigned = {
    schemaVersion: 1 as const,
    newLaunchRequired: true as const,
    previousLaunch: {
      launchKey: record.launch.launchKey,
      descriptorDigest: record.launch.descriptorDigest,
    },
    recordId: record.recordId,
    runtimeQualifiedId: record.runtimeQualifiedId,
    runtime: record.runtime,
    identity: record.identity,
    nativeBindingRef: record.nativeBindingRef,
    nativeSessionRef: record.nativeSessionRef,
    nativeVerificationDigest: stableDigest({
      recordedRootDigest: recorded.recordedRootDigest,
      process: record.process,
      headerDigest,
    }),
    cwd: record.location.cwd,
    projectId: record.location.project,
    repositoryId: record.location.repository,
    launch: record.launch,
  };
  return unsigned;
}

async function persistResumeVerification(
  store: SessionStore,
  record: SessionRecordV1,
  state: SessionRecordV1['resume']['state'],
  diagnostic: string | null,
  lastPlanDigest: string | null,
): Promise<void> {
  const verifiedAt = new Date().toISOString();
  await store.transaction(record.identity, record.runtime, (registry) => ({
    registry: {
      ...registry,
      records: registry.records.map((candidate) =>
        candidate.recordId === record.recordId
          ? parseSessionRecordV1({
              ...candidate,
              resume: {
                state,
                diagnostic,
                lastVerifiedAt: verifiedAt,
                lastPlanDigest,
              },
              timestamps: { ...candidate.timestamps, updatedAt: verifiedAt },
            })
          : candidate,
      ),
    },
    result: undefined,
  }));
}

export async function planResume(
  store: SessionStore,
  input: SessionRecordV1,
  dependencies: ResumeDependencies,
): Promise<HistoricalResumePlanV1> {
  const record = parseSessionRecordV1(input);
  let plan: HistoricalResumePlanV1;
  try {
    const seed = await verifyNativeResumeSeed(store, record, dependencies);
    plan = { ...seed, confirmationDigest: stableDigest(seed) };
  } catch (error) {
    const code = error instanceof SessionError ? error.code : 'SESSION_RESUME_FAILED';
    const state =
      !(error instanceof SessionError) || code.endsWith('_UNAVAILABLE') ? 'unavailable' : 'blocked';
    try {
      await persistResumeVerification(store, record, state, code, null);
    } catch {
      // Diagnostic persistence is best-effort and must not hide validation failure.
    }
    throw error;
  }
  await persistResumeVerification(store, record, 'resumable', null, plan.confirmationDigest);
  return plan;
}

export function verifyResumeConfirmation(
  plan: HistoricalResumePlanV1,
  confirmationDigest: string,
): void {
  const { confirmationDigest: ignored, ...unsigned } = plan;
  void ignored;
  if (
    stableDigest(unsigned) !== confirmationDigest ||
    plan.confirmationDigest !== confirmationDigest
  ) {
    throw new SessionError(
      'SESSION_RESUME_CONFIRMATION_MISMATCH',
      'resume plan confirmation digest does not match',
    );
  }
}
