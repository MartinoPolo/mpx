import type { NativeSessionRefV1, RuntimeName } from "@mpx/runtime-contracts";
import { SessionStore } from "./store.js";
import {
  SessionError,
  parseSessionRecordV1,
  stableDigest,
  type IdentityV1,
  type LaunchSnapshotV1,
  type SessionRecordV1,
} from "./schemas.js";

export interface ConfiguredNativeRoot {
  readonly root: string;
  readonly canonicalRootDigest: string;
  readonly identity: IdentityV1;
  readonly runtime: RuntimeName;
}
export type AccountBindingVerification =
  | "verified"
  | "unavailable"
  | "mismatch"
  | "duplicate";
export interface ResumeDependencies {
  resolveConfiguredRoot(
    nativeBindingRef: string,
  ): Promise<ConfiguredNativeRoot>;
  verifyAccountBinding?(
    accountBindingRef: string,
  ): Promise<AccountBindingVerification>;
  verifyNativeTarget(
    root: string,
    ref: NativeSessionRefV1,
    runtimeQualifiedId: string,
  ): Promise<{ valid: boolean; activity: "active" | "inactive" | "unavailable" }>;
}
export interface ResumePlanV1 {
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
  readonly cwd: string;
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  readonly launch: LaunchSnapshotV1;
  readonly confirmationDigest: string;
}

async function buildResumePlan(
  store: SessionStore,
  input: SessionRecordV1,
  dependencies: ResumeDependencies,
): Promise<ResumePlanV1> {
  const record = parseSessionRecordV1(input);
  if (record.launch === null)
    throw new SessionError(
      "SESSION_RESUME_LAUNCH_UNBOUND",
      "session has no recorded launch snapshot",
    );
  const recorded = await store.readNativeBinding(record.nativeBindingRef);
  if (
    recorded.identity.domain !== record.identity.domain ||
    recorded.identity.name !== record.identity.name ||
    recorded.runtime !== record.runtime
  )
    throw new SessionError(
      "SESSION_RESUME_BINDING_MISMATCH",
      "record and native binding identity/runtime differ",
    );
  const configured = await dependencies.resolveConfiguredRoot(
    record.nativeBindingRef,
  );
  if (
    configured.identity.domain !== recorded.identity.domain ||
    configured.identity.name !== recorded.identity.name ||
    configured.runtime !== recorded.runtime
  )
    throw new SessionError(
      "SESSION_RESUME_IDENTITY_MISMATCH",
      "configured identity/runtime differs from recorded binding",
    );
  if (configured.canonicalRootDigest !== recorded.recordedRootDigest)
    throw new SessionError(
      "SESSION_RESUME_ROOT_MISMATCH",
      "configured canonical root digest differs from recorded digest",
    );
  if (record.runtime === "pi") {
    if (
      recorded.accountBindingRef === null ||
      !dependencies.verifyAccountBinding
    )
      throw new SessionError(
        "SESSION_RESUME_ACCOUNT_UNAVAILABLE",
        "Pi account-binding verification is unavailable",
      );
    const result = await dependencies.verifyAccountBinding(
      recorded.accountBindingRef,
    );
    if (result !== "verified")
      throw new SessionError(
        `SESSION_RESUME_ACCOUNT_${result.toUpperCase()}`,
        `Pi account-binding verification returned ${result}`,
      );
  }
  const target = await dependencies.verifyNativeTarget(
    configured.root,
    record.nativeSessionRef,
    record.runtimeQualifiedId,
  );
  if (!target.valid)
    throw new SessionError(
      "SESSION_RESUME_NATIVE_TARGET_INVALID",
      "native session id/file is missing, unsafe, or outside its recorded root",
    );
  if (target.activity === "unavailable")
    throw new SessionError(
      "SESSION_RESUME_ACTIVITY_UNAVAILABLE",
      "native session activity could not be inspected",
    );
  if (target.activity === "active")
    throw new SessionError(
      "SESSION_RESUME_ACTIVE",
      "native session is still active",
    );
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
    cwd: record.location.cwd,
    projectId: record.location.project,
    repositoryId: record.location.repository,
    launch: record.launch,
  };
  return { ...unsigned, confirmationDigest: stableDigest(unsigned) };
}

async function persistResumeVerification(
  store: SessionStore,
  record: SessionRecordV1,
  state: SessionRecordV1["resume"]["state"],
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
): Promise<ResumePlanV1> {
  const record = parseSessionRecordV1(input);
  let plan: ResumePlanV1;
  try {
    plan = await buildResumePlan(store, record, dependencies);
  } catch (error) {
    const code = error instanceof SessionError
      ? error.code
      : "SESSION_RESUME_FAILED";
    const state =
      !(error instanceof SessionError) || code.endsWith("_UNAVAILABLE")
        ? "unavailable"
        : "blocked";
    try {
      await persistResumeVerification(store, record, state, code, null);
    } catch {
      // Diagnostic persistence is best-effort and must not hide validation failure.
    }
    throw error;
  }
  await persistResumeVerification(
    store,
    record,
    "resumable",
    null,
    plan.confirmationDigest,
  );
  return plan;
}

export function verifyResumeConfirmation(
  plan: ResumePlanV1,
  confirmationDigest: string,
): void {
  const { confirmationDigest: ignored, ...unsigned } = plan;
  void ignored;
  if (
    stableDigest(unsigned) !== confirmationDigest ||
    plan.confirmationDigest !== confirmationDigest
  )
    throw new SessionError(
      "SESSION_RESUME_CONFIRMATION_MISMATCH",
      "resume plan confirmation digest does not match",
    );
}
