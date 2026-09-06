import { createHash } from 'node:crypto';
import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import {
  canonicalJson,
  installerDigest,
  type InstallIntentV1,
  type InstallOperationV1,
  type OwnershipReceiptV1,
  type ReleaseManifestV1,
} from './immutable-core.js';
import { withInstallerCleanup } from './failure.js';
import {
  PI_NATIVE_PACKAGE_ROOT,
  invertPiNativePackageSettings,
  parsePiNativePackageRegistration,
  parsePiPackageSettingsPlanV1,
  parsePiSettings,
  planPiNativePackageSettings,
  resolvePiNativePackageSource,
  serializePiSettings,
  type PiNativePackageRegistrationV1,
  type PiPackageSettingsPlanV1,
} from './pi-native-package.js';
import {
  type PiNativeSettingsLock,
  type PiNativeSettingsPort,
  type PiPrivateRootResolver,
} from './pi-native-settings.js';
import {
  assertPiNativePackagesMatchRelease,
  type AccountDomain,
  type RuntimeIdentity,
} from './runtime-registration.js';

const missing = (failure: unknown): boolean => (failure as NodeJS.ErrnoException).code === 'ENOENT';

function fail(code: string, message: string, cause?: unknown): never {
  const failure = new MpxError({ code, message });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { value: cause, configurable: true });
  }
  throw failure;
}

const sha = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');

const normalizedPrivateRoot = (value: string): string =>
  path.win32
    .normalize(value)
    .replace(/[\\]+$/u, '')
    .toLowerCase();

const samePrivatePath = (left: string, right: string): boolean =>
  normalizedPrivateRoot(left) === normalizedPrivateRoot(right);

const nativeRootDigest = (value: string): string => installerDigest(normalizedPrivateRoot(value));

const absolutePackageSource = (value: string): boolean =>
  path.posix.isAbsolute(value) || path.win32.isAbsolute(value);

interface PiReleasePlanInput {
  readonly releaseRoot: string;
  readonly desiredSource: string;
  readonly nativePackage: PiNativePackageRegistrationV1;
  readonly priorOwnedSources: readonly string[];
}

function deriveReleasePlanInput(
  appsRoot: string,
  releaseKey: string,
  nativePackage: PiNativePackageRegistrationV1,
  priorReleaseKey?: string,
): PiReleasePlanInput {
  const releaseRoot = path.join(appsRoot, 'mpx', 'releases', releaseKey);
  return {
    releaseRoot,
    desiredSource: resolvePiNativePackageSource(releaseRoot, PI_NATIVE_PACKAGE_ROOT),
    nativePackage,
    priorOwnedSources: priorReleaseKey
      ? [
          resolvePiNativePackageSource(
            path.join(appsRoot, 'mpx', 'releases', priorReleaseKey),
            PI_NATIVE_PACKAGE_ROOT,
          ),
        ]
      : [],
  };
}

async function verifyPiPackageArtifacts(
  nativeSettings: PiNativeSettingsPort,
  input: PiReleasePlanInput,
): Promise<void> {
  for (const file of input.nativePackage.files) {
    const candidate = path.join(input.desiredSource, ...file.path.split('/'));
    let info;
    try {
      info = await nativeSettings.lstat(candidate);
    } catch (failure) {
      fail(
        'INSTALL_PI_PACKAGE_DRIFT',
        'The immutable Pi package is unavailable or changed.',
        failure,
      );
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) {
      fail('INSTALL_PI_PACKAGE_DRIFT', 'The immutable Pi package is unavailable or changed.');
    }
    let body: Buffer;
    try {
      body = await nativeSettings.read(candidate);
    } catch (failure) {
      fail(
        'INSTALL_PI_PACKAGE_DRIFT',
        'The immutable Pi package is unavailable or changed.',
        failure,
      );
    }
    if (sha(body) !== file.sha256) {
      fail('INSTALL_PI_PACKAGE_DRIFT', 'The immutable Pi package is unavailable or changed.');
    }
  }
}

function piPlanEvidence(plan: PiPackageSettingsPlanV1): PiPackageSettingsPlanV1 {
  const { planDigest: _digest, settings: _settings, ...base } = plan;
  const evidence = { ...base, settings: { packages: plan.packagesAfter } };
  return { ...evidence, planDigest: installerDigest(evidence) };
}

interface PiSettingsOwnedAnchorV1 {
  readonly source: string;
  readonly packagesBeforeIndex: number;
  readonly unownedBefore: number;
}

interface PiSettingsForwardPlanV1 {
  readonly packagesBefore: readonly unknown[];
  readonly packagesAfter: readonly unknown[];
  readonly ownedAnchors: readonly PiSettingsOwnedAnchorV1[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly planDigest: string;
}

interface PiSettingsSnapshotV1 {
  readonly mode: 'ensure' | 'remove';
  readonly settingsExisted: boolean;
  readonly packagesExisted: boolean;
  readonly forwardPlan: PiSettingsForwardPlanV1;
}

function parsePiSettingsSnapshot(value: unknown): PiSettingsSnapshotV1 {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('snapshot');
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join('\0') !==
        'forwardPlan\0kind\0mode\0packagesExisted\0schemaVersion\0settingsExisted' ||
      record.schemaVersion !== 1 ||
      record.kind !== 'pi-settings-snapshot' ||
      (record.mode !== 'ensure' && record.mode !== 'remove') ||
      typeof record.settingsExisted !== 'boolean' ||
      typeof record.packagesExisted !== 'boolean' ||
      (!record.settingsExisted && record.packagesExisted) ||
      !record.forwardPlan ||
      typeof record.forwardPlan !== 'object' ||
      Array.isArray(record.forwardPlan)
    ) {
      throw new Error('snapshot');
    }
    const plan = record.forwardPlan as Record<string, unknown>;
    if (
      Object.keys(plan).sort().join('\0') !==
        'afterDigest\0beforeDigest\0ownedAnchors\0packagesAfter\0packagesBefore\0planDigest' ||
      !Array.isArray(plan.packagesBefore) ||
      !Array.isArray(plan.packagesAfter) ||
      !Array.isArray(plan.ownedAnchors) ||
      typeof plan.beforeDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(plan.beforeDigest) ||
      typeof plan.afterDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(plan.afterDigest) ||
      typeof plan.planDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(plan.planDigest)
    ) {
      throw new Error('forward plan');
    }
    const packagesBefore = (parsePiSettings({ packages: plan.packagesBefore }).packages ??
        []) as readonly unknown[],
      packagesAfter = (parsePiSettings({ packages: plan.packagesAfter }).packages ??
        []) as readonly unknown[],
      ownedAnchors = plan.ownedAnchors.map((candidate): PiSettingsOwnedAnchorV1 => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new Error('owned anchor');
        }
        const anchor = candidate as Record<string, unknown>;
        if (
          Object.keys(anchor).sort().join('\0') !== 'packagesBeforeIndex\0source\0unownedBefore' ||
          typeof anchor.source !== 'string' ||
          !absolutePackageSource(anchor.source) ||
          !Number.isSafeInteger(anchor.packagesBeforeIndex) ||
          (anchor.packagesBeforeIndex as number) < 0 ||
          !Number.isSafeInteger(anchor.unownedBefore) ||
          (anchor.unownedBefore as number) < 0
        ) {
          throw new Error('owned anchor');
        }
        return {
          source: anchor.source,
          packagesBeforeIndex: anchor.packagesBeforeIndex as number,
          unownedBefore: anchor.unownedBefore as number,
        };
      }),
      base = {
        packagesBefore,
        packagesAfter,
        ownedAnchors,
        beforeDigest: plan.beforeDigest,
        afterDigest: plan.afterDigest,
      };
    if (
      installerDigest(packagesBefore) !== plan.beforeDigest ||
      installerDigest(packagesAfter) !== plan.afterDigest ||
      installerDigest({ mode: record.mode, ...base }) !== plan.planDigest
    ) {
      throw new Error('forward plan digest');
    }
    return {
      mode: record.mode,
      settingsExisted: record.settingsExisted,
      packagesExisted: record.packagesExisted,
      forwardPlan: { ...base, planDigest: plan.planDigest },
    };
  } catch (failure) {
    fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi settings rollback evidence is malformed.', failure);
  }
}

function decodePiSettingsSnapshot(value: string): unknown {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi settings rollback evidence is malformed.');
  }
  try {
    const body = Buffer.from(value, 'base64');
    if (body.toString('base64') !== value) {
      throw new Error('base64');
    }
    return parseStrictJson(body.toString('utf8'));
  } catch (failure) {
    fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi settings rollback evidence is malformed.', failure);
  }
}

interface PiSettingsRootInspection {
  readonly canonicalRoot: string;
  readonly settingsPath: string;
  readonly settings: unknown | undefined;
}

export async function inspectPiSettingsRoot(
  nativeSettings: PiNativeSettingsPort,
  root: string,
): Promise<PiSettingsRootInspection> {
  let rootInfo;
  try {
    rootInfo = await nativeSettings.lstat(root);
  } catch (failure) {
    if (missing(failure)) {
      fail('INSTALL_PI_ROOT_UNAVAILABLE', 'A registered Pi root is unavailable.', failure);
    }
    fail('INSTALL_PI_SETTINGS_UNAVAILABLE', 'A registered Pi root could not be verified.', failure);
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('INSTALL_PI_SETTINGS_UNHEALTHY', 'A registered Pi root is not a real directory.');
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await nativeSettings.realpath(root);
  } catch (failure) {
    fail('INSTALL_PI_SETTINGS_UNAVAILABLE', 'A registered Pi root could not be verified.', failure);
  }
  if (!samePrivatePath(canonicalRoot, root)) {
    fail('INSTALL_PI_SETTINGS_UNHEALTHY', 'A registered Pi root contains a reparse boundary.');
  }
  const settingsPath = path.join(canonicalRoot, 'settings.json');
  let body: Buffer | undefined;
  try {
    const info = await nativeSettings.lstat(settingsPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      fail('INSTALL_PI_SETTINGS_UNHEALTHY', 'Pi settings are not a real regular file.');
    }
    if (!samePrivatePath(await nativeSettings.realpath(settingsPath), settingsPath)) {
      fail('INSTALL_PI_SETTINGS_UNHEALTHY', 'Pi settings contain a reparse boundary.');
    }
    body = await nativeSettings.read(settingsPath);
  } catch (failure) {
    if (!missing(failure)) {
      if (failure instanceof MpxError) {
        throw failure;
      }
      fail('INSTALL_PI_SETTINGS_UNAVAILABLE', 'Pi settings could not be read safely.', failure);
    }
  }
  if (!body) {
    return { canonicalRoot, settingsPath, settings: undefined };
  }
  try {
    return {
      canonicalRoot,
      settingsPath,
      settings: parsePiSettings(parseStrictJson(body.toString('utf8'))),
    };
  } catch (failure) {
    fail('INSTALL_PI_SETTINGS_UNHEALTHY', 'Pi settings JSON is malformed or unsafe.', failure);
  }
}

interface PiIdentityBinding {
  readonly identity: RuntimeIdentity;
  readonly domain: AccountDomain;
  readonly nativeRootDigest: string;
}

interface PiReleaseBinding {
  readonly releaseKey: string;
  readonly packageRoot: typeof PI_NATIVE_PACKAGE_ROOT;
  readonly registrationDigest: string;
  readonly registration: PiNativePackageRegistrationV1;
}

interface PiSettingsLocator {
  readonly bindings: readonly PiIdentityBinding[];
  readonly currentRelease: PiReleaseBinding;
  readonly priorRelease: PiReleaseBinding | null;
  readonly plan: PiPackageSettingsPlanV1;
}

function releaseBinding(
  releaseKey: string,
  registration: PiNativePackageRegistrationV1,
): PiReleaseBinding {
  return {
    releaseKey,
    packageRoot: PI_NATIVE_PACKAGE_ROOT,
    registrationDigest: installerDigest(registration),
    registration,
  };
}

export function parsePiSettingsLocator(value: unknown): PiSettingsLocator {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('locator');
    }
    const locator = value as Record<string, unknown>;
    if (
      Object.keys(locator).sort().join('\0') !==
        'bindings\0currentRelease\0kind\0plan\0priorRelease\0schemaVersion' ||
      locator.schemaVersion !== 1 ||
      locator.kind !== 'pi-settings' ||
      !Array.isArray(locator.bindings) ||
      locator.bindings.length === 0 ||
      locator.bindings.length > 2
    ) {
      throw new Error('locator');
    }
    const bindings = locator.bindings.map((candidate): PiIdentityBinding => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('binding');
      }
      const binding = candidate as Record<string, unknown>;
      if (
        Object.keys(binding).sort().join('\0') !== 'domain\0identity\0nativeRootDigest' ||
        (binding.domain !== 'personal' && binding.domain !== 'work') ||
        binding.identity !== `pi-${binding.domain}` ||
        typeof binding.nativeRootDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(binding.nativeRootDigest)
      ) {
        throw new Error('binding');
      }
      return {
        domain: binding.domain,
        identity: binding.identity as RuntimeIdentity,
        nativeRootDigest: binding.nativeRootDigest,
      };
    });
    if (new Set(bindings.map((binding) => binding.identity)).size !== bindings.length) {
      throw new Error('binding');
    }
    const parseRelease = (candidate: unknown): PiReleaseBinding => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('release');
      }
      const release = candidate as Record<string, unknown>;
      if (
        Object.keys(release).sort().join('\0') !==
          'packageRoot\0registration\0registrationDigest\0releaseKey' ||
        typeof release.releaseKey !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(release.releaseKey) ||
        release.packageRoot !== PI_NATIVE_PACKAGE_ROOT ||
        typeof release.registrationDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(release.registrationDigest)
      ) {
        throw new Error('release');
      }
      const registration = parsePiNativePackageRegistration(release.registration);
      if (installerDigest(registration) !== release.registrationDigest) {
        throw new Error('release');
      }
      return releaseBinding(release.releaseKey, registration);
    };
    return {
      bindings,
      currentRelease: parseRelease(locator.currentRelease),
      priorRelease: locator.priorRelease === null ? null : parseRelease(locator.priorRelease),
      plan: parsePiPackageSettingsPlanV1(locator.plan),
    };
  } catch (failure) {
    if (failure instanceof MpxError && failure.code === 'INSTALL_RECEIPT_FORGED') {
      throw failure;
    }
    fail('INSTALL_RECEIPT_FORGED', 'Pi settings locator is malformed.', failure);
  }
}

interface PiSettingsEntryBase {
  readonly operation: InstallOperationV1;
  readonly root: string;
  readonly settingsPath: string;
  readonly bindings: readonly PiIdentityBinding[];
  readonly releaseKey: string;
  readonly registration: PiNativePackageRegistrationV1;
  readonly plan: PiPackageSettingsPlanV1;
}

type PiSettingsEntry = PiSettingsEntryBase &
  (
    | { readonly priorReleaseKey?: never; readonly priorRegistration?: never }
    | {
        readonly priorReleaseKey: string;
        readonly priorRegistration: PiNativePackageRegistrationV1;
      }
  );

export interface PiNativeSettingsOperation {
  plan(
    intent: InstallIntentV1,
    manifest: ReleaseManifestV1,
    requireActual: boolean,
    priorReceipt?: OwnershipReceiptV1,
  ): Promise<readonly InstallOperationV1[]>;
  handles(operation: InstallOperationV1, locator?: unknown): boolean;
  receiptLocator(operation: InstallOperationV1): Promise<unknown>;
  hydrateReceiptOperation(operation: InstallOperationV1, locator: unknown): Promise<void>;
  observe(operation: InstallOperationV1): Promise<string | null>;
  capture(operation: InstallOperationV1): Promise<string | null>;
  apply(operation: InstallOperationV1): Promise<void>;
  restore(operation: InstallOperationV1, snapshot: string | null): Promise<void>;
}

export class PiNativeSettingsOperationService implements PiNativeSettingsOperation {
  private readonly entries = new Map<string, PiSettingsEntry>();

  constructor(
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private nativeSettings: PiNativeSettingsPort,
    private readonly privateRoots: PiPrivateRootResolver,
    private readonly adapterName: string,
  ) {}

  setNativeSettingsPort(port: PiNativeSettingsPort): void {
    this.nativeSettings = port;
  }

  handles(operation: InstallOperationV1, locator?: unknown): boolean {
    return (
      operation.target.startsWith('pi:') ||
      (locator !== null &&
        typeof locator === 'object' &&
        !Array.isArray(locator) &&
        (locator as Record<string, unknown>).kind === 'pi-settings')
    );
  }

  private appsRoot(): string {
    return (
      this.environment.MPX_APPS ?? fail('INSTALL_MUTABLE_ROOT_UNAVAILABLE', 'MPX_APPS is required.')
    );
  }

  private releasePlanInput(entry: PiSettingsEntry): PiReleasePlanInput {
    return deriveReleasePlanInput(
      this.appsRoot(),
      entry.releaseKey,
      entry.registration,
      entry.priorReleaseKey,
    );
  }

  private planFor(entry: PiSettingsEntry, settings: unknown | undefined): PiPackageSettingsPlanV1 {
    return planPiNativePackageSettings({ settings, ...this.releasePlanInput(entry) });
  }

  private forwardPlan(
    mode: PiSettingsSnapshotV1['mode'],
    packagesBefore: readonly unknown[],
    packagesAfter: readonly unknown[],
    ownedAnchors: readonly PiSettingsOwnedAnchorV1[],
  ): PiSettingsForwardPlanV1 {
    const base = {
      packagesBefore,
      packagesAfter,
      ownedAnchors,
      beforeDigest: installerDigest(packagesBefore),
      afterDigest: installerDigest(packagesAfter),
    };
    return { ...base, planDigest: installerDigest({ mode, ...base }) };
  }

  private ownedAnchors(
    entry: PiSettingsEntry,
    packages: readonly unknown[],
  ): readonly PiSettingsOwnedAnchorV1[] {
    return this.planFor(entry, { packages }).priorOwnedEntries;
  }

  private assertExactOwnedSources(
    entry: PiSettingsEntry,
    packages: readonly unknown[],
    expected: readonly PiSettingsOwnedAnchorV1[],
  ): void {
    const actualSources = this.ownedAnchors(entry, packages).map((anchor) => anchor.source),
      expectedSources = expected.map((anchor) => anchor.source);
    if (canonicalJson(actualSources) !== canonicalJson(expectedSources)) {
      fail(
        'INSTALL_FOREIGN_OR_DRIFTED',
        'Refusing to restore over foreign Pi package ownership changes.',
      );
    }
  }

  private reconstructForwardPlan(
    entry: PiSettingsEntry,
    snapshot: PiSettingsSnapshotV1,
  ): PiSettingsForwardPlanV1 {
    const supplied = snapshot.forwardPlan;
    try {
      let expected: PiSettingsForwardPlanV1;
      if (snapshot.mode === 'ensure') {
        const plan = piPlanEvidence(this.planFor(entry, { packages: supplied.packagesBefore }));
        expected = this.forwardPlan(
          snapshot.mode,
          plan.packagesBefore,
          plan.packagesAfter,
          plan.priorOwnedEntries,
        );
      } else {
        const beforePlan = piPlanEvidence(
          this.planFor(entry, { packages: supplied.packagesBefore }),
        );
        if (
          beforePlan.priorOwnedEntries.length !== 1 ||
          beforePlan.priorOwnedEntries[0]?.source !== beforePlan.desiredSource
        ) {
          throw new Error('remove ownership');
        }
        const inverted = invertPiNativePackageSettings({
          settings: { packages: supplied.packagesBefore },
          plan: entry.plan,
          priorOwnedSources: this.releasePlanInput(entry).priorOwnedSources,
        });
        expected = this.forwardPlan(
          snapshot.mode,
          supplied.packagesBefore,
          inverted.packagesAfter,
          beforePlan.priorOwnedEntries,
        );
      }
      if (canonicalJson(expected) !== canonicalJson(supplied)) {
        throw new Error('forward plan');
      }
      return expected;
    } catch (failure) {
      fail(
        'INSTALL_PI_SETTINGS_DRIFT',
        'Pi settings rollback evidence does not match trusted release ownership.',
        failure,
      );
    }
  }

  async plan(
    intent: InstallIntentV1,
    manifest: ReleaseManifestV1,
    requireActual: boolean,
    priorReceipt?: OwnershipReceiptV1,
  ): Promise<readonly InstallOperationV1[]> {
    if (!intent.runtimeRegistrations) {
      return [];
    }
    assertPiNativePackagesMatchRelease(manifest, intent.runtimeRegistrations);
    const piRegistrations = intent.runtimeRegistrations.registrations.filter(
      (item) => item.runtime === 'pi',
    );
    const physicalRoots = new Map<
      string,
      {
        inspection: PiSettingsRootInspection;
        bindings: PiIdentityBinding[];
        registration: PiNativePackageRegistrationV1;
      }
    >();
    const appsRoot = this.appsRoot();
    for (const registration of piRegistrations) {
      let privateRoot: string | undefined;
      try {
        privateRoot = await this.privateRoots.resolvePiNativeRoot({
          identity: registration.identity,
          expectedNativeRootDigest: registration.nativeRootDigest,
          ...(intent.userConfigArtifact
            ? { userConfigArtifactContent: intent.userConfigArtifact.content }
            : {}),
        });
      } catch (failure) {
        fail('INSTALL_PI_ROOT_UNAVAILABLE', 'A registered Pi root is unavailable.', failure);
      }
      if (!privateRoot || !path.isAbsolute(privateRoot)) {
        fail('INSTALL_PI_ROOT_UNAVAILABLE', 'A registered Pi root is unavailable.');
      }
      const inspection = await inspectPiSettingsRoot(this.nativeSettings, privateRoot);
      if (nativeRootDigest(privateRoot) !== registration.nativeRootDigest) {
        fail('INSTALL_PI_ROOT_MISMATCH', 'A private Pi root does not match its registration.');
      }
      const planInput = deriveReleasePlanInput(
        appsRoot,
        intent.releaseKey,
        registration.nativePackage,
      );
      if (requireActual) {
        await verifyPiPackageArtifacts(this.nativeSettings, planInput);
      }
      const key = normalizedPrivateRoot(inspection.canonicalRoot);
      const existing = physicalRoots.get(key);
      const binding = {
        identity: registration.identity,
        domain: registration.domain,
        nativeRootDigest: registration.nativeRootDigest,
      };
      if (existing) {
        existing.bindings.push(binding);
      } else {
        physicalRoots.set(key, {
          inspection,
          bindings: [binding],
          registration: registration.nativePackage,
        });
      }
    }
    const priorPiLocators = (priorReceipt?.operationLocators ?? []).flatMap((locator) => {
      const isPiOperation = locator.operationId.startsWith('50-pi-settings-');
      const isPiLocator =
        locator.spec !== null &&
        typeof locator.spec === 'object' &&
        !Array.isArray(locator.spec) &&
        (locator.spec as Record<string, unknown>).kind === 'pi-settings';
      return isPiOperation || isPiLocator ? [parsePiSettingsLocator(locator.spec)] : [];
    });
    const operations: InstallOperationV1[] = [];
    for (const value of physicalRoots.values()) {
      const first = value.bindings[0];
      if (!first) {
        fail('INSTALL_SCHEMA_INVALID', 'Pi settings root has no identity binding.');
      }
      const priorCandidate = priorReceipt?.installIntent?.runtimeRegistrations?.registrations.find(
        (candidate) =>
          candidate.runtime === 'pi' &&
          value.bindings.some(
            (binding) =>
              binding.identity === candidate.identity &&
              binding.nativeRootDigest === candidate.nativeRootDigest,
          ),
      );
      const priorLocator = priorCandidate
        ? priorPiLocators.find(
            (locator) =>
              locator.bindings.some(
                (binding) =>
                  binding.identity === priorCandidate.identity &&
                  binding.nativeRootDigest === priorCandidate.nativeRootDigest,
              ) &&
              locator.currentRelease.releaseKey === priorReceipt?.releaseKey &&
              locator.currentRelease.registrationDigest ===
                installerDigest(priorCandidate.nativePackage),
          )
        : undefined;
      const priorRegistration =
        priorLocator && priorCandidate?.runtime === 'pi' ? priorCandidate : undefined;
      const priorReleaseKey =
        priorRegistration && priorReceipt ? priorReceipt.releaseKey : undefined;
      const planInput = deriveReleasePlanInput(
        appsRoot,
        intent.releaseKey,
        value.registration,
        priorReleaseKey,
      );
      const plan = planPiNativePackageSettings({
        settings: value.inspection.settings,
        ...planInput,
      });
      if (requireActual) {
        const packages =
          (parsePiSettings(value.inspection.settings).packages as unknown[] | undefined) ?? [];
        if (
          packages.filter((item) => item === planInput.desiredSource).length !== 1 ||
          planInput.priorOwnedSources.some(
            (source) =>
              source !== planInput.desiredSource && packages.some((item) => item === source),
          )
        ) {
          fail('INSTALL_REGISTRATION_UNHEALTHY', 'Pi native package actual state is unhealthy.');
        }
      }
      const operation: InstallOperationV1 = {
        id: `50-pi-settings-${first.domain}`,
        adapter: this.adapterName,
        action: 'ensure',
        target: `pi:${first.domain}:settings-packages`,
        desiredDigest: plan.afterDigest,
      };
      const common: PiSettingsEntryBase = {
        operation,
        root: value.inspection.canonicalRoot,
        settingsPath: value.inspection.settingsPath,
        bindings: value.bindings,
        releaseKey: intent.releaseKey,
        registration: value.registration,
        plan,
      };
      const entry: PiSettingsEntry =
        priorReleaseKey && priorRegistration
          ? {
              ...common,
              priorReleaseKey,
              priorRegistration: priorRegistration.nativePackage,
            }
          : common;
      for (const [digest, priorEntry] of this.entries) {
        if (
          priorEntry.operation.id === operation.id &&
          priorEntry.operation.target === operation.target
        ) {
          this.entries.delete(digest);
        }
      }
      this.entries.set(installerDigest(operation), entry);
      operations.push(operation);
    }
    return operations;
  }

  private async entry(operation: InstallOperationV1): Promise<PiSettingsEntry> {
    const exact = this.entries.get(installerDigest(operation));
    if (exact) {
      return exact;
    }
    if (operation.action === 'remove') {
      for (const entry of this.entries.values()) {
        if (entry.operation.id === operation.id && entry.operation.target === operation.target) {
          return entry;
        }
      }
    }
    return fail('INSTALL_PLAN_STALE', `Unknown or stale production operation ${operation.id}.`);
  }

  async receiptLocator(operation: InstallOperationV1): Promise<unknown> {
    const entry = await this.entry(operation);
    return {
      schemaVersion: 1,
      kind: 'pi-settings',
      bindings: entry.bindings,
      currentRelease: releaseBinding(entry.releaseKey, entry.registration),
      priorRelease:
        entry.priorReleaseKey && entry.priorRegistration
          ? releaseBinding(entry.priorReleaseKey, entry.priorRegistration)
          : null,
      plan: piPlanEvidence(entry.plan),
    };
  }

  async hydrateReceiptOperation(operation: InstallOperationV1, locator: unknown): Promise<void> {
    const locatorValue = parsePiSettingsLocator(locator);
    const firstBinding = locatorValue.bindings[0];
    if (!firstBinding) {
      fail('INSTALL_RECEIPT_FORGED', 'Pi settings locator operation is invalid.');
    }
    const planInput = deriveReleasePlanInput(
      this.appsRoot(),
      locatorValue.currentRelease.releaseKey,
      locatorValue.currentRelease.registration,
      locatorValue.priorRelease?.releaseKey,
    );
    if (
      operation.target !== `pi:${firstBinding.domain}:settings-packages` ||
      (operation.action === 'ensure' &&
        installerDigest(locatorValue.plan.packagesAfter) !== operation.desiredDigest) ||
      (operation.action === 'remove' && operation.desiredDigest !== null) ||
      !samePrivatePath(locatorValue.plan.desiredSource, planInput.desiredSource)
    ) {
      fail('INSTALL_RECEIPT_FORGED', 'Pi settings locator binding is invalid.');
    }
    try {
      invertPiNativePackageSettings({
        settings: locatorValue.plan.settings,
        plan: locatorValue.plan,
        priorOwnedSources: planInput.priorOwnedSources,
      });
    } catch (failure) {
      fail(
        'INSTALL_RECEIPT_FORGED',
        'Pi settings locator ownership is not authorized by its release registrations.',
        failure,
      );
    }
    let inspected: PiSettingsRootInspection | undefined;
    for (const binding of locatorValue.bindings) {
      let privateRoot: string | undefined;
      try {
        privateRoot = await this.privateRoots.resolvePiNativeRoot({
          identity: binding.identity,
          expectedNativeRootDigest: binding.nativeRootDigest,
        });
      } catch (failure) {
        fail('INSTALL_PI_ROOT_UNAVAILABLE', 'A registered Pi root is unavailable.', failure);
      }
      if (!privateRoot || !path.isAbsolute(privateRoot)) {
        fail('INSTALL_PI_ROOT_UNAVAILABLE', 'A registered Pi root is unavailable.');
      }
      const candidate = await inspectPiSettingsRoot(this.nativeSettings, privateRoot);
      if (
        nativeRootDigest(privateRoot) !== binding.nativeRootDigest ||
        (inspected && !samePrivatePath(candidate.canonicalRoot, inspected.canonicalRoot))
      ) {
        fail('INSTALL_RECEIPT_FORGED', 'Pi settings locator root binding is invalid.');
      }
      inspected = candidate;
    }
    if (!inspected) {
      fail('INSTALL_RECEIPT_FORGED', 'Pi settings locator root binding is invalid.');
    }
    const common: PiSettingsEntryBase = {
      operation,
      root: inspected.canonicalRoot,
      settingsPath: inspected.settingsPath,
      bindings: locatorValue.bindings,
      releaseKey: locatorValue.currentRelease.releaseKey,
      registration: locatorValue.currentRelease.registration,
      plan: locatorValue.plan,
    };
    const entry: PiSettingsEntry = locatorValue.priorRelease
      ? {
          ...common,
          priorReleaseKey: locatorValue.priorRelease.releaseKey,
          priorRegistration: locatorValue.priorRelease.registration,
        }
      : common;
    this.entries.set(installerDigest(operation), entry);
  }

  private assertLock(lock: PiNativeSettingsLock): void {
    const compromised = lock.compromisedFailure();
    if (compromised) {
      throw compromised;
    }
  }

  private async withLock<T>(
    entry: PiSettingsEntry,
    action: (settings: unknown | undefined, lock: PiNativeSettingsLock) => Promise<T>,
  ): Promise<T> {
    let lock: PiNativeSettingsLock;
    try {
      lock = await this.nativeSettings.lock(entry.settingsPath);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ELOCKED') {
        fail('INSTALL_PI_SETTINGS_LOCKED', 'Pi settings are locked by another process.', failure);
      }
      fail('INSTALL_PI_SETTINGS_UNAVAILABLE', 'Pi settings could not be locked.', failure);
    }
    return withInstallerCleanup(
      async () => {
        this.assertLock(lock);
        const inspected = await inspectPiSettingsRoot(this.nativeSettings, entry.root);
        this.assertLock(lock);
        if (
          !samePrivatePath(inspected.canonicalRoot, entry.root) ||
          !samePrivatePath(inspected.settingsPath, entry.settingsPath)
        ) {
          fail('INSTALL_PI_SETTINGS_UNHEALTHY', 'Pi settings identity changed while locked.');
        }
        const result = await action(inspected.settings, lock);
        this.assertLock(lock);
        return result;
      },
      async () => {
        try {
          await lock.release();
        } catch (failure) {
          fail(
            'INSTALL_PI_SETTINGS_UNAVAILABLE',
            'Pi settings lock could not be released.',
            failure,
          );
        }
      },
      'Pi settings operation and lock cleanup both failed.',
    );
  }

  private async writeSettings(
    lock: PiNativeSettingsLock,
    entry: PiSettingsEntry,
    settings: unknown,
  ): Promise<void> {
    this.assertLock(lock);
    try {
      await this.nativeSettings.atomicWrite(
        entry.settingsPath,
        Buffer.from(serializePiSettings(settings)),
      );
    } catch (failure) {
      if (failure instanceof MpxError) {
        throw failure;
      }
      fail('INSTALL_PI_SETTINGS_UNAVAILABLE', 'Pi settings could not be updated.', failure);
    }
    this.assertLock(lock);
  }

  private async removeSettings(lock: PiNativeSettingsLock, entry: PiSettingsEntry): Promise<void> {
    this.assertLock(lock);
    try {
      await this.nativeSettings.remove(entry.settingsPath);
    } catch (failure) {
      fail('INSTALL_PI_SETTINGS_UNAVAILABLE', 'Pi settings could not be restored.', failure);
    }
    this.assertLock(lock);
  }

  async observe(operation: InstallOperationV1): Promise<string | null> {
    const entry = await this.entry(operation);
    return this.withLock(entry, async (settings) => {
      const packages = (parsePiSettings(settings).packages as unknown[] | undefined) ?? [];
      return installerDigest(packages);
    });
  }

  async capture(operation: InstallOperationV1): Promise<string | null> {
    const entry = await this.entry(operation);
    return this.withLock(entry, async (settings) => {
      const parsed = parsePiSettings(settings),
        packagesBefore = (parsed.packages as readonly unknown[] | undefined) ?? [];
      let forwardPlan: PiSettingsForwardPlanV1;
      if (operation.action === 'remove') {
        const beforePlan = piPlanEvidence(this.planFor(entry, { packages: packagesBefore }));
        if (
          beforePlan.priorOwnedEntries.length !== 1 ||
          beforePlan.priorOwnedEntries[0]?.source !== beforePlan.desiredSource
        ) {
          fail(
            'INSTALL_FOREIGN_OR_DRIFTED',
            'Refusing to remove foreign Pi package ownership changes.',
          );
        }
        const inverted = invertPiNativePackageSettings({
          settings: { packages: packagesBefore },
          plan: entry.plan,
          priorOwnedSources: this.releasePlanInput(entry).priorOwnedSources,
        });
        forwardPlan = this.forwardPlan(
          'remove',
          packagesBefore,
          inverted.packagesAfter,
          beforePlan.priorOwnedEntries,
        );
      } else {
        const plan = piPlanEvidence(this.planFor(entry, { packages: packagesBefore }));
        forwardPlan = this.forwardPlan(
          'ensure',
          plan.packagesBefore,
          plan.packagesAfter,
          plan.priorOwnedEntries,
        );
      }
      return Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          kind: 'pi-settings-snapshot',
          mode: operation.action,
          settingsExisted: settings !== undefined,
          packagesExisted:
            settings !== undefined && Object.prototype.hasOwnProperty.call(parsed, 'packages'),
          forwardPlan,
        }),
      ).toString('base64');
    });
  }

  async apply(operation: InstallOperationV1): Promise<void> {
    const entry = await this.entry(operation);
    await this.withLock(entry, async (settings, lock) => {
      if (operation.action === 'remove') {
        const inverted = invertPiNativePackageSettings({
          settings: settings ?? {},
          plan: entry.plan,
          priorOwnedSources: this.releasePlanInput(entry).priorOwnedSources,
        });
        await this.writeSettings(lock, entry, inverted.settings);
        return;
      }
      const fresh = this.planFor(entry, settings);
      if (fresh.beforeDigest !== entry.plan.beforeDigest) {
        fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi package settings changed after planning.');
      }
      this.assertLock(lock);
      await verifyPiPackageArtifacts(this.nativeSettings, this.releasePlanInput(entry));
      this.assertLock(lock);
      if (fresh.beforeDigest !== fresh.afterDigest) {
        await this.writeSettings(lock, entry, fresh.settings);
      }
    });
  }

  private restoreRemovedPackages(
    entry: PiSettingsEntry,
    currentPackages: readonly unknown[],
    forward: PiSettingsForwardPlanV1,
  ): readonly unknown[] {
    const expectedAfterAnchors = this.ownedAnchors(entry, forward.packagesAfter),
      actualAfterAnchors = this.ownedAnchors(entry, currentPackages);
    this.assertExactOwnedSources(entry, currentPackages, expectedAfterAnchors);
    const expectedOwnedIndices = new Set(
        expectedAfterAnchors.map((anchor) => anchor.packagesBeforeIndex),
      ),
      actualOwnedIndices = new Set(actualAfterAnchors.map((anchor) => anchor.packagesBeforeIndex)),
      baseline = forward.packagesAfter.filter((_item, index) => !expectedOwnedIndices.has(index)),
      currentUnowned = currentPackages.filter((_item, index) => !actualOwnedIndices.has(index)),
      beforeOwnedIndices = new Set(
        forward.ownedAnchors.map((anchor) => anchor.packagesBeforeIndex),
      ),
      beforeUnowned = forward.packagesBefore.filter(
        (_item, index) => !beforeOwnedIndices.has(index),
      );
    if (canonicalJson(beforeUnowned) !== canonicalJson(baseline)) {
      fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi remove rollback anchors are inconsistent.');
    }
    let cursor = 0;
    const matchedIndices: number[] = [];
    for (const expected of baseline) {
      while (
        cursor < currentUnowned.length &&
        canonicalJson(currentUnowned[cursor]) !== canonicalJson(expected)
      ) {
        cursor += 1;
      }
      if (cursor === currentUnowned.length) {
        fail('INSTALL_FOREIGN_OR_DRIFTED', 'Refusing to restore over foreign Pi package changes.');
      }
      matchedIndices.push(cursor);
      cursor += 1;
    }
    const desiredAnchor = forward.ownedAnchors[0];
    if (!desiredAnchor || desiredAnchor.source !== this.releasePlanInput(entry).desiredSource) {
      fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi remove rollback ownership is inconsistent.');
    }
    const insertionIndex =
      baseline.length === 0
        ? currentUnowned.length
        : desiredAnchor.unownedBefore === baseline.length
          ? matchedIndices[matchedIndices.length - 1]! + 1
          : matchedIndices[desiredAnchor.unownedBefore];
    if (insertionIndex === undefined) {
      fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi remove rollback anchor is unavailable.');
    }
    return [
      ...currentUnowned.slice(0, insertionIndex),
      desiredAnchor.source,
      ...currentUnowned.slice(insertionIndex),
    ];
  }

  async restore(operation: InstallOperationV1, snapshot: string | null): Promise<void> {
    const entry = await this.entry(operation);
    if (snapshot === null) {
      fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi settings rollback evidence is unavailable.');
    }
    const snapshotEvidence = parsePiSettingsSnapshot(decodePiSettingsSnapshot(snapshot));
    if (snapshotEvidence.mode !== operation.action) {
      fail('INSTALL_PI_SETTINGS_DRIFT', 'Pi settings rollback operation mode changed.');
    }
    const forward = this.reconstructForwardPlan(entry, snapshotEvidence);
    await this.withLock(entry, async (settings, lock) => {
      const currentPackages =
        (parsePiSettings(settings).packages as readonly unknown[] | undefined) ?? [];
      if (installerDigest(currentPackages) === forward.beforeDigest) {
        return;
      }
      if (operation.action === 'remove') {
        const restoredPackages = this.restoreRemovedPackages(entry, currentPackages, forward),
          restoredSettings = { ...parsePiSettings(settings), packages: restoredPackages };
        await this.writeSettings(lock, entry, restoredSettings);
        return;
      }
      const expectedAppliedAnchors = this.ownedAnchors(entry, forward.packagesAfter);
      this.assertExactOwnedSources(entry, currentPackages, expectedAppliedAnchors);
      const trustedPlan = piPlanEvidence(this.planFor(entry, { packages: forward.packagesBefore })),
        inverted = invertPiNativePackageSettings({
          settings: settings ?? {},
          plan: trustedPlan,
          priorOwnedSources: this.releasePlanInput(entry).priorOwnedSources,
        }),
        restoredSettings = { ...inverted.settings } as Record<string, unknown>;
      if (!snapshotEvidence.packagesExisted && inverted.packagesAfter.length === 0) {
        delete restoredSettings.packages;
      }
      if (!snapshotEvidence.settingsExisted && Object.keys(restoredSettings).length === 0) {
        await this.removeSettings(lock, entry);
      } else {
        await this.writeSettings(lock, entry, restoredSettings);
      }
    });
  }
}
