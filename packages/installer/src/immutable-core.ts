import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MpxError, parseStrictJson } from '@mpx/core';
import {
  canonicalJson,
  compareReleasePaths,
  exact,
  installerDigest,
  parseReleaseManifestV1,
  safeRelative,
  SHA,
  type ReleaseFileV1,
  type ReleaseManifestV1,
} from './release-manifest.js';
import {
  parseRuntimeRegistrationMatrixV1,
  parseStaticMcpRegistrationV1,
  type RuntimeRegistrationMatrixV1,
  type StaticMcpRegistrationV1,
} from './runtime-registration.js';
import { withInstallerCleanup } from './failure.js';

export { canonicalJson, installerDigest, parseReleaseManifestV1 } from './release-manifest.js';
export type { ReleaseFileV1, ReleaseManifestV1 } from './release-manifest.js';

export const USER_CONFIG_ARTIFACT_MAX_BYTES = 65_536;

export interface UserConfigArtifactV1 {
  readonly target: '%APPDATA%/mpx/config.json';
  readonly content: string;
  readonly sha256: string;
}
export interface InstallIntentV1 {
  readonly schemaVersion: 1;
  readonly kind: 'install-intent';
  readonly releaseKey: string;
  readonly convergenceHash: string;
  readonly components: readonly string[];
  readonly userConfigArtifact?: UserConfigArtifactV1;
  readonly runtimeRegistrations?: RuntimeRegistrationMatrixV1;
  readonly staticMcpRegistrations?: readonly StaticMcpRegistrationV1[];
}
export interface MachineObservationV1 {
  readonly id: string;
  readonly digest: string | null;
}
export interface InstallOperationV1 {
  readonly id: string;
  readonly adapter: string;
  readonly action: 'ensure' | 'remove';
  readonly target: string;
  readonly desiredDigest: string | null;
}
export interface InstallPlanReferenceV1 {
  readonly id: string;
  readonly planDigest: string;
  readonly verifierRef: string;
}
export interface InstallOperationClassificationsV1 {
  readonly automatic: readonly string[];
  readonly confirmationRequired: readonly InstallPlanReferenceV1[];
}
export interface InstallPlanV1 {
  readonly schemaVersion: 1;
  readonly kind: 'install-plan';
  readonly intent: InstallIntentV1;
  readonly observations: readonly MachineObservationV1[];
  readonly operations: readonly InstallOperationV1[];
  readonly classifications?: InstallOperationClassificationsV1;
  readonly confirmationDigest: string;
}
export interface InstallOperationLocatorV1 {
  readonly operationId: string;
  readonly adapter: string;
  readonly spec: unknown;
  readonly bindingDigest: string;
}
export interface OwnershipReceiptV1 {
  readonly schemaVersion: 2;
  readonly kind: 'ownership-receipt';
  readonly releaseKey: string;
  readonly convergenceHash: string;
  readonly files: readonly ReleaseFileV1[];
  readonly operations: readonly InstallOperationV1[];
  readonly operationLocators: readonly InstallOperationLocatorV1[];
  readonly installIntent?: InstallIntentV1;
  readonly installedAt: string;
}
export interface InstallVerificationComponentV1 {
  readonly id: string;
  readonly automatic: true;
  readonly status: 'actual-state-verified' | 'unhealthy';
}
export interface InstallVerificationV1 {
  readonly schemaVersion: 1;
  readonly kind: 'install-verification';
  readonly releaseKey: string;
  readonly healthy: boolean;
  readonly issues: readonly string[];
  readonly checkedAt: string;
  readonly components?: readonly InstallVerificationComponentV1[];
}
export interface MachineSnapshotV1 {
  readonly schemaVersion: 1;
  readonly kind: 'machine-snapshot';
  readonly transactionId: string;
  readonly observations: readonly MachineObservationV1[];
  readonly capturedAt: string;
}
export interface TransactionJournalV1 {
  readonly schemaVersion: 1;
  readonly kind: 'transaction-journal';
  readonly transactionId: string;
  readonly phase: 'applying' | 'committed' | 'rolled-back';
  readonly completedOperationIds: readonly string[];
  readonly inFlightOperationId?: string;
  readonly snapshot: MachineSnapshotV1;
}

function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}

export function parseInstallIntentV1(value: unknown): InstallIntentV1 {
  const record = value as Record<string, unknown> | null;
  const has = (key: string): boolean =>
    Boolean(record && Object.prototype.hasOwnProperty.call(record, key));
  const hasRuntime = has('runtimeRegistrations'),
    hasMcp = has('staticMcpRegistrations'),
    hasUserConfig = has('userConfigArtifact');
  const intent = exact(value, [
    'schemaVersion',
    'kind',
    'releaseKey',
    'convergenceHash',
    'components',
    ...(hasUserConfig ? ['userConfigArtifact'] : []),
    ...(hasRuntime ? ['runtimeRegistrations'] : []),
    ...(hasMcp ? ['staticMcpRegistrations'] : []),
  ]);
  if (
    intent.schemaVersion !== 1 ||
    intent.kind !== 'install-intent' ||
    typeof intent.releaseKey !== 'string' ||
    !SHA.test(intent.releaseKey) ||
    intent.releaseKey !== intent.convergenceHash ||
    !Array.isArray(intent.components) ||
    intent.components.some((x) => typeof x !== 'string' || !x) ||
    new Set(intent.components).size !== intent.components.length ||
    intent.components.some((x, i, a) => i > 0 && a[i - 1].localeCompare(x) >= 0)
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid install intent.');
  }
  let userConfigArtifact: UserConfigArtifactV1 | undefined;
  if (hasUserConfig) {
    const artifact = exact(intent.userConfigArtifact, ['target', 'content', 'sha256']);
    if (
      artifact.target !== '%APPDATA%/mpx/config.json' ||
      typeof artifact.content !== 'string' ||
      Buffer.byteLength(artifact.content, 'utf8') > USER_CONFIG_ARTIFACT_MAX_BYTES ||
      typeof artifact.sha256 !== 'string' ||
      !SHA.test(artifact.sha256)
    ) {
      fail('INSTALL_SCHEMA_INVALID', 'Invalid user-config artifact.');
    }
    try {
      parseStrictJson(artifact.content);
    } catch {
      fail('INSTALL_SCHEMA_INVALID', 'User-config content must be strict JSON.');
    }
    if (createHash('sha256').update(artifact.content, 'utf8').digest('hex') !== artifact.sha256) {
      fail('INSTALL_SCHEMA_INVALID', 'User-config artifact content or digest is invalid.');
    }
    userConfigArtifact = artifact as unknown as UserConfigArtifactV1;
  }
  const runtimeRegistrations = hasRuntime
    ? parseRuntimeRegistrationMatrixV1(intent.runtimeRegistrations)
    : undefined;
  const staticMcpRegistrations =
    hasMcp && Array.isArray(intent.staticMcpRegistrations)
      ? intent.staticMcpRegistrations.map(parseStaticMcpRegistrationV1)
      : hasMcp
        ? fail('INSTALL_SCHEMA_INVALID', 'Static MCP registrations must be an array.')
        : undefined;
  if (
    staticMcpRegistrations &&
    (new Set(staticMcpRegistrations.map((item) => item.label)).size !==
      staticMcpRegistrations.length ||
      staticMcpRegistrations.some(
        (item, index, all) => index > 0 && all[index - 1]!.label.localeCompare(item.label) >= 0,
      ))
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Static MCP registrations must be unique and sorted.');
  }
  return {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey: intent.releaseKey,
    convergenceHash: intent.convergenceHash,
    components: intent.components as string[],
    ...(userConfigArtifact ? { userConfigArtifact } : {}),
    ...(runtimeRegistrations ? { runtimeRegistrations } : {}),
    ...(staticMcpRegistrations ? { staticMcpRegistrations } : {}),
  };
}
function parseObservation(value: unknown): MachineObservationV1 {
  const x = exact(value, ['id', 'digest']);
  if (
    typeof x.id !== 'string' ||
    !x.id ||
    !(x.digest === null || (typeof x.digest === 'string' && SHA.test(x.digest)))
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid observation.');
  }
  return x as unknown as MachineObservationV1;
}
export function parseInstallOperationV1(value: unknown): InstallOperationV1 {
  const x = exact(value, ['id', 'adapter', 'action', 'target', 'desiredDigest']);
  if (
    typeof x.id !== 'string' ||
    !x.id ||
    typeof x.adapter !== 'string' ||
    !x.adapter ||
    !['ensure', 'remove'].includes(x.action as string) ||
    typeof x.target !== 'string' ||
    !x.target ||
    !(
      x.desiredDigest === null ||
      (typeof x.desiredDigest === 'string' && SHA.test(x.desiredDigest))
    )
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid operation.');
  }
  return x as unknown as InstallOperationV1;
}
function orderedUnique<T extends { id: string }>(values: T[]): boolean {
  return (
    new Set(values.map((x) => x.id)).size === values.length &&
    values.every((x, i) => i === 0 || values[i - 1]!.id.localeCompare(x.id) < 0)
  );
}
function parseReferences(value: unknown): InstallOperationClassificationsV1 {
  const record = exact(value, ['automatic', 'confirmationRequired']);
  const references = (items: unknown): InstallPlanReferenceV1[] => {
    if (!Array.isArray(items)) {
      fail('INSTALL_SCHEMA_INVALID', 'Plan references must be arrays.');
    }
    return items.map((item) => {
      const ref = exact(item, ['id', 'planDigest', 'verifierRef']);
      if (
        typeof ref.id !== 'string' ||
        !ref.id ||
        typeof ref.planDigest !== 'string' ||
        !SHA.test(ref.planDigest) ||
        typeof ref.verifierRef !== 'string' ||
        !ref.verifierRef
      ) {
        fail('INSTALL_SCHEMA_INVALID', 'Plan reference is invalid.');
      }
      return ref as unknown as InstallPlanReferenceV1;
    });
  };
  if (
    !Array.isArray(record.automatic) ||
    record.automatic.some((id) => typeof id !== 'string' || !id)
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Automatic classifications are invalid.');
  }
  const parsed = {
    automatic: record.automatic as string[],
    confirmationRequired: references(record.confirmationRequired),
  };
  return parsed;
}
export function parseInstallPlanV1(value: unknown): InstallPlanV1 {
  const source = value as Record<string, unknown> | null,
    hasClassifications = Boolean(
      source && Object.prototype.hasOwnProperty.call(source, 'classifications'),
    );
  const plan = exact(value, [
    'schemaVersion',
    'kind',
    'intent',
    'observations',
    'operations',
    ...(hasClassifications ? ['classifications'] : []),
    'confirmationDigest',
  ]);
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== 'install-plan' ||
    !Array.isArray(plan.observations) ||
    !Array.isArray(plan.operations) ||
    typeof plan.confirmationDigest !== 'string' ||
    !SHA.test(plan.confirmationDigest)
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid install plan.');
  }
  const parsed = {
    schemaVersion: 1 as const,
    kind: 'install-plan' as const,
    intent: parseInstallIntentV1(plan.intent),
    observations: plan.observations.map(parseObservation),
    operations: plan.operations.map(parseInstallOperationV1),
    ...(hasClassifications ? { classifications: parseReferences(plan.classifications) } : {}),
  };
  if (
    !orderedUnique(parsed.observations) ||
    !orderedUnique(parsed.operations) ||
    installerDigest(parsed) !== plan.confirmationDigest ||
    (parsed.classifications &&
      installerDigest(parsed.classifications.automatic) !==
        installerDigest(
          parsed.operations
            .slice(0, parsed.classifications.automatic.length)
            .map((operation) => operation.id),
        ))
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid plan confirmation or ordering.');
  }
  return { ...parsed, confirmationDigest: plan.confirmationDigest };
}
function boundedLocatorSpec(value: unknown): unknown {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 4_096 || depth > 16) {
      fail('INSTALL_SCHEMA_INVALID', 'Install operation locator is too large.');
    }
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      return item;
    }
    if (Array.isArray(item)) {
      return item.map((child) => visit(child, depth + 1));
    }
    if (!item || typeof item !== 'object') {
      fail('INSTALL_SCHEMA_INVALID', 'Install operation locator is invalid.');
    }
    const entries = Object.entries(item as Record<string, unknown>);
    if (entries.some(([key]) => !key || key.length > 128)) {
      fail('INSTALL_SCHEMA_INVALID', 'Install operation locator is invalid.');
    }
    return Object.fromEntries(
      entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, visit(child, depth + 1)]),
    );
  };
  const parsed = visit(value, 0);
  if (Buffer.byteLength(canonicalJson(parsed), 'utf8') > 65_536) {
    fail('INSTALL_SCHEMA_INVALID', 'Install operation locator is too large.');
  }
  return parsed;
}

export function parseInstallOperationLocatorsV1(
  value: unknown,
  operations: readonly InstallOperationV1[],
): readonly InstallOperationLocatorV1[] {
  if (!Array.isArray(value) || value.length !== operations.length) {
    fail('INSTALL_SCHEMA_INVALID', 'Operation locators must be ordered and complete.');
  }
  return value.map((item, index): InstallOperationLocatorV1 => {
    const locator = exact(item, ['operationId', 'adapter', 'spec', 'bindingDigest']),
      operation = operations[index]!,
      spec = boundedLocatorSpec(locator.spec);
    if (
      locator.operationId !== operation.id ||
      locator.adapter !== operation.adapter ||
      typeof locator.bindingDigest !== 'string' ||
      !SHA.test(locator.bindingDigest) ||
      locator.bindingDigest !== installerDigest({ operation, spec })
    ) {
      fail('INSTALL_SCHEMA_INVALID', 'Operation locator binding is invalid.');
    }
    return {
      operationId: operation.id,
      adapter: operation.adapter,
      spec,
      bindingDigest: locator.bindingDigest,
    };
  });
}

export function parseOwnershipReceiptV1(value: unknown): OwnershipReceiptV1 {
  const source = value as Record<string, unknown> | null,
    hasIntent = Boolean(source && Object.prototype.hasOwnProperty.call(source, 'installIntent'));
  const receipt = exact(value, [
    'schemaVersion',
    'kind',
    'releaseKey',
    'convergenceHash',
    'files',
    'operations',
    'operationLocators',
    ...(hasIntent ? ['installIntent'] : []),
    'installedAt',
  ]);
  if (
    receipt.schemaVersion !== 2 ||
    receipt.kind !== 'ownership-receipt' ||
    typeof receipt.installedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.installedAt)) ||
    !Array.isArray(receipt.operations) ||
    !Array.isArray(receipt.operationLocators)
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid or legacy-ambiguous ownership receipt.');
  }
  const manifest = parseReleaseManifestV1({
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey: receipt.releaseKey,
    convergenceHash: receipt.convergenceHash,
    files: receipt.files,
  });
  const operations = receipt.operations.map(parseInstallOperationV1);
  if (!orderedUnique(operations)) {
    fail('INSTALL_SCHEMA_INVALID', 'Receipt operations must be sorted and unique.');
  }
  const operationLocators = parseInstallOperationLocatorsV1(receipt.operationLocators, operations);
  const installIntent = hasIntent ? parseInstallIntentV1(receipt.installIntent) : undefined;
  if (installIntent && installIntent.releaseKey !== manifest.releaseKey) {
    fail('INSTALL_SCHEMA_INVALID', 'Receipt intent does not match its release.');
  }
  return {
    schemaVersion: 2,
    kind: 'ownership-receipt',
    releaseKey: manifest.releaseKey,
    convergenceHash: manifest.convergenceHash,
    files: manifest.files,
    operations,
    operationLocators,
    ...(installIntent ? { installIntent } : {}),
    installedAt: receipt.installedAt,
  };
}
export function parseMachineSnapshotV1(value: unknown): MachineSnapshotV1 {
  const snapshot = exact(value, [
    'schemaVersion',
    'kind',
    'transactionId',
    'observations',
    'capturedAt',
  ]);
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.kind !== 'machine-snapshot' ||
    typeof snapshot.transactionId !== 'string' ||
    !snapshot.transactionId ||
    !Array.isArray(snapshot.observations) ||
    typeof snapshot.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.capturedAt))
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid machine snapshot.');
  }
  const observations = snapshot.observations.map(parseObservation);
  if (!orderedUnique(observations)) {
    fail('INSTALL_SCHEMA_INVALID', 'Snapshot observations must be sorted.');
  }
  return {
    schemaVersion: 1,
    kind: 'machine-snapshot',
    transactionId: snapshot.transactionId,
    observations,
    capturedAt: snapshot.capturedAt,
  };
}

async function walk(
  root: string,
  relative = '',
  excludeDependencies = false,
): Promise<ReleaseFileV1[]> {
  const directory = path.join(root, ...relative.split('/').filter(Boolean));
  const names = (await readdir(directory))
    .filter((name) => !excludeDependencies || name !== 'node_modules')
    .sort(compareReleasePaths);
  const result: ReleaseFileV1[] = [];
  for (const name of names) {
    const rel = relative ? `${relative}/${name}` : name;
    if (!safeRelative(rel)) {
      fail('INSTALL_RELEASE_PATH_ESCAPE', 'Unsafe release path.');
    }
    const absolute = path.join(root, ...rel.split('/'));
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      fail('INSTALL_RELEASE_UNSAFE_ENTRY', 'Release contains a link or special entry.');
    }
    if (info.isDirectory()) {
      result.push(...(await walk(root, rel, excludeDependencies)));
    } else {
      const body = await readFile(absolute);
      result.push({
        path: rel,
        bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    }
  }
  return result;
}
export async function buildReleaseManifest(sourceDirectory: string): Promise<ReleaseManifestV1> {
  const info = await lstat(sourceDirectory).catch(() =>
    fail('INSTALL_RELEASE_SOURCE_INVALID', 'Release source is unavailable.'),
  );
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('INSTALL_RELEASE_SOURCE_INVALID', 'Release source must be a regular directory.');
  }
  const files = (await walk(sourceDirectory)).sort((left, right) =>
    compareReleasePaths(left.path, right.path),
  );
  const convergenceHash = installerDigest(files);
  return {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey: convergenceHash,
    convergenceHash,
    files,
  };
}
async function copyManifest(
  source: string,
  destination: string,
  manifest: ReleaseManifestV1,
): Promise<void> {
  for (const file of manifest.files) {
    const target = path.join(destination, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, ...file.path.split('/')), target);
  }
  await writeFile(path.join(destination, 'release-manifest.json'), `${canonicalJson(manifest)}\n`, {
    flag: 'wx',
    mode: 0o444,
  });
  const copied = await buildReleaseManifestWithoutMetadata(destination);
  if (copied.convergenceHash !== manifest.convergenceHash) {
    fail('INSTALL_RELEASE_COPY_DRIFT', 'Staged release differs from source.');
  }
}
async function buildReleaseManifestWithoutMetadata(root: string): Promise<ReleaseManifestV1> {
  const all = await walk(root);
  const files = all
    .filter((x) => x.path !== 'release-manifest.json')
    .sort((left, right) => compareReleasePaths(left.path, right.path));
  const convergenceHash = installerDigest(files);
  return {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey: convergenceHash,
    convergenceHash,
    files,
  };
}
export async function publishRelease(options: {
  sourceDirectory: string;
  appsRoot: string;
  releaseKey?: string;
}): Promise<ReleaseManifestV1> {
  const manifest = await buildReleaseManifest(options.sourceDirectory);
  if (options.releaseKey !== undefined && options.releaseKey !== manifest.releaseKey) {
    fail('INSTALL_RELEASE_KEY_MISMATCH', 'Requested key does not describe source content.');
  }
  const releases = path.join(options.appsRoot, 'mpx', 'releases'),
    destination = path.join(releases, manifest.releaseKey);
  await mkdir(releases, { recursive: true });
  try {
    const existing = await lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail('INSTALL_RELEASE_COLLISION', 'Release destination is unsafe.');
    }
    const actual = await buildReleaseManifestWithoutMetadata(destination);
    if (actual.convergenceHash !== manifest.convergenceHash) {
      fail('INSTALL_RELEASE_COLLISION', 'Existing release is drifted.');
    }
    return manifest;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw failure;
    }
  }
  const staging = path.join(releases, `.staging-${manifest.releaseKey}-${randomUUID()}`);
  await mkdir(staging, { recursive: false });
  await withInstallerCleanup(
    async () => {
      await copyManifest(options.sourceDirectory, staging, manifest);
      try {
        await rename(staging, destination);
      } catch (failure) {
        if (
          (failure as NodeJS.ErrnoException).code !== 'EEXIST' &&
          (failure as NodeJS.ErrnoException).code !== 'ENOTEMPTY'
        ) {
          throw failure;
        }
        const actual = await buildReleaseManifestWithoutMetadata(destination);
        if (actual.convergenceHash !== manifest.convergenceHash) {
          fail('INSTALL_RELEASE_COLLISION', 'Concurrent release differs.');
        }
      }
    },
    () => rm(staging, { recursive: true, force: true }),
    'Release publication and staging cleanup both failed.',
  );
  return manifest;
}

export interface InstalledReleaseEvidence {
  readonly path: string;
  readonly sha256: string;
  readonly bytes?: number;
  readonly version: string;
}
export class NodeInstalledReleaseAuthority {
  constructor(
    private readonly options: {
      appsRoot: string;
      receipt: () => Promise<OwnershipReceiptV1 | undefined>;
      prohibitedRoots?: readonly string[];
    },
  ) {}
  async verifyInstalled(evidence: InstalledReleaseEvidence): Promise<InstalledReleaseEvidence> {
    if (!path.isAbsolute(evidence.path) || !SHA.test(evidence.sha256)) {
      fail('INSTALL_RUNNER_UNAVAILABLE', 'Runner evidence is invalid.');
    }
    const releaseRoot = path.resolve(this.options.appsRoot, 'mpx', 'releases'),
      candidate = path.resolve(evidence.path),
      relative = path.relative(releaseRoot, candidate);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      (this.options.prohibitedRoots ?? []).some(
        (root) =>
          root &&
          (candidate === path.resolve(root) ||
            candidate.startsWith(`${path.resolve(root)}${path.sep}`)),
      )
    ) {
      fail('INSTALL_RUNNER_UNAVAILABLE', 'Runner is outside immutable release authority.');
    }
    const parts = relative.split(path.sep);
    if (parts.length < 2 || !SHA.test(parts[0]!)) {
      fail('INSTALL_RUNNER_UNAVAILABLE', 'Runner has no immutable release key.');
    }
    const receipt = await this.options.receipt();
    const filePath = parts.slice(1).join('/');
    const owned =
      receipt && receipt.releaseKey === parts[0]
        ? receipt.files.find((x) => x.path === filePath)
        : undefined;
    if (
      !owned ||
      owned.sha256 !== evidence.sha256 ||
      (evidence.bytes !== undefined && evidence.bytes !== owned.bytes)
    ) {
      fail('INSTALL_RUNNER_UNAVAILABLE', 'Runner is not bound to ownership receipt.');
    }
    const handle = await open(candidate, 'r').catch(() =>
      fail('INSTALL_RUNNER_UNAVAILABLE', 'Runner is unavailable.'),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== owned.bytes) {
        fail('INSTALL_RUNNER_STALE', 'Runner size changed.');
      }
      const body = await handle.readFile();
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== owned.sha256) {
        fail('INSTALL_RUNNER_STALE', 'Runner hash changed.');
      }
      return {
        ...evidence,
        path: candidate,
        sha256: actual,
        ...(evidence.bytes === undefined ? {} : { bytes: info.size }),
      };
    } finally {
      await handle.close();
    }
  }
}

export interface CurrentReleaseOptions {
  readonly repositoryRoot: string;
  readonly assetPaths?: readonly string[];
}

const PI_EXTENSION_ARTIFACT = 'runtimes/pi/extensions/dist/package';
const PI_EXTENSION_RELEASE_SCRIPT = 'runtimes/pi/extensions/scripts/release.mjs';

function canonicalPiArtifactSelection(assets: readonly string[]): 'included' | 'excluded' {
  const canonicalArtifact = PI_EXTENSION_ARTIFACT.toLowerCase();
  let included = false;
  for (const asset of assets) {
    const comparableAsset = asset.toLowerCase();
    if (
      canonicalArtifact.startsWith(`${comparableAsset}/`) ||
      comparableAsset === canonicalArtifact
    ) {
      included = true;
    } else if (comparableAsset.startsWith(`${canonicalArtifact}/`)) {
      fail(
        'INSTALL_RELEASE_ARTIFACT_INVALID',
        'Custom asset paths must include the complete canonical Pi extension artifact.',
      );
    }
  }
  return included ? 'included' : 'excluded';
}

async function verifyPiExtensionArtifact(repositoryRoot: string): Promise<void> {
  try {
    const script = path.join(repositoryRoot, ...PI_EXTENSION_RELEASE_SCRIPT.split('/'));
    const release = (await import(pathToFileURL(script).href)) as {
      verifyRelease?: () => Promise<void>;
    };
    if (typeof release.verifyRelease !== 'function') {
      throw new Error('Canonical release verifier is unavailable');
    }
    await release.verifyRelease();
  } catch {
    fail(
      'INSTALL_RELEASE_ARTIFACT_INVALID',
      'Canonical Pi extension release artifact failed verification.',
    );
  }
}

async function verifyImmutableReleaseSource(
  repositoryRoot: string,
): Promise<ReleaseManifestV1 | undefined> {
  const resolved = path.resolve(repositoryRoot),
    releaseKey = path.basename(resolved),
    releases = path.dirname(resolved);
  if (
    !SHA.test(releaseKey) ||
    path.basename(releases) !== 'releases' ||
    path.basename(path.dirname(releases)) !== 'mpx'
  ) {
    return undefined;
  }
  try {
    const rootInfo = await lstat(repositoryRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('Immutable release root is unsafe');
    }
    const manifestPath = path.join(repositoryRoot, 'release-manifest.json'),
      manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new Error('Immutable release manifest is unsafe');
    }
    const manifest = parseReleaseManifestV1(parseStrictJson(await readFile(manifestPath, 'utf8')));
    if (manifest.releaseKey !== releaseKey) {
      throw new Error('Immutable release basename does not match its manifest');
    }
    const actual = await buildReleaseManifestWithoutMetadata(repositoryRoot);
    if (canonicalJson(actual) !== canonicalJson(manifest)) {
      throw new Error('Immutable release inventory differs from its manifest');
    }
    return manifest;
  } catch {
    fail('INSTALL_RELEASE_ARTIFACT_INVALID', 'Immutable release source failed verification.');
  }
}

async function withCurrentReleaseSource<T>(
  options: CurrentReleaseOptions,
  action: (sourceDirectory: string) => Promise<T>,
): Promise<T> {
  const assets = options.assetPaths ?? [
    'bin',
    'content',
    'evidence',
    'packages/subagents/dist',
    'runtimes',
    'LICENSE',
    'LICENSE.md',
  ];
  const immutableManifest = await verifyImmutableReleaseSource(options.repositoryRoot);
  if (canonicalPiArtifactSelection(assets) === 'included' && !immutableManifest) {
    await verifyPiExtensionArtifact(options.repositoryRoot);
  }
  const staging = await mkdtemp(path.join(tmpdir(), 'mpx-current-release-'));
  return withInstallerCleanup(
    async () => {
      for (const asset of [...assets].sort(compareReleasePaths)) {
        if (!safeRelative(asset)) {
          fail('INSTALL_RELEASE_PATH_ESCAPE', 'Unsafe repository asset path.');
        }
        const source = path.join(options.repositoryRoot, ...asset.split('/'));
        const info = await lstat(source).catch((failure) => {
          if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
          }
          throw failure;
        });
        if (!info) {
          continue;
        }
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
          fail('INSTALL_RELEASE_UNSAFE_ENTRY', 'Repository asset is unsafe.');
        }
        const destination = path.join(staging, ...asset.split('/'));
        if (info.isFile()) {
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(source, destination);
        } else {
          const entries = await walk(source, '', true);
          for (const entry of entries) {
            const target = path.join(destination, ...entry.path.split('/'));
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(path.join(source, ...entry.path.split('/')), target);
          }
        }
      }
      if (immutableManifest) {
        const expectedFiles = immutableManifest.files.filter((file) =>
          assets.some((asset) => {
            const relative = path.relative(
              path.resolve(options.repositoryRoot, asset),
              path.resolve(options.repositoryRoot, file.path),
            );
            return (
              relative !== '..' &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative)
            );
          }),
        );
        const stagedManifest = await buildReleaseManifest(staging);
        if (canonicalJson(stagedManifest.files) !== canonicalJson(expectedFiles)) {
          fail('INSTALL_RELEASE_COPY_DRIFT', 'Staged release differs from verified source.');
        }
      }
      return action(staging);
    },
    () => rm(staging, { recursive: true, force: true }),
    'Current-release staging and cleanup both failed.',
  );
}
export async function buildCurrentReleaseManifest(
  options: CurrentReleaseOptions,
): Promise<ReleaseManifestV1> {
  return withCurrentReleaseSource(options, buildReleaseManifest);
}
export async function publishCurrentRelease(
  options: CurrentReleaseOptions & { readonly appsRoot: string },
): Promise<ReleaseManifestV1> {
  return withCurrentReleaseSource(options, (sourceDirectory) =>
    publishRelease({ sourceDirectory, appsRoot: options.appsRoot }),
  );
}
async function observeActiveRelease(localAppData: string): Promise<string | null> {
  const file = path.join(localAppData, 'mpx', 'active-release');
  let info;
  try {
    info = await lstat(file);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw failure;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail('INSTALL_SELECTOR_UNAVAILABLE', 'Active release selector is unsafe.');
  }
  const key = (await readFile(file, 'utf8')).trim();
  if (!SHA.test(key)) {
    fail('INSTALL_SELECTOR_UNAVAILABLE', 'Active release selector is invalid.');
  }
  return key;
}
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === 'EPERM';
  }
}
async function publishOwner(file: string, owner: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, owner, { flag: 'wx', mode: 0o600 });
    await link(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function releaseExactOwner(file: string, owner: string, label: string): Promise<void> {
  if ((await readFile(file, 'utf8').catch(() => '')) !== owner) {
    return;
  }
  const claim = `${file}.${label}-${randomUUID()}`;
  try {
    await rename(file, claim);
    if ((await readFile(claim, 'utf8').catch(() => '')) === owner) {
      await rm(claim, { force: true });
    }
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw failure;
    }
  }
}
export async function acquireAtomicOwnerLock(
  lock: string,
  lockedCode: string,
  lockedMessage: string,
): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lock), { recursive: true });
  const recoveryGuard = `${lock}.recovery-guard`,
    deadline = Date.now() + 30_000;
  for (;;) {
    if (
      await readFile(recoveryGuard).then(
        () => true,
        (failure) => {
          if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
          }
          throw failure;
        },
      )
    ) {
      if (Date.now() >= deadline) {
        fail(lockedCode, lockedMessage);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    const owner = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID() })}\n`;
    try {
      await publishOwner(lock, owner);
      return () => releaseExactOwner(lock, owner, 'release');
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw failure;
      }
      const observed = await readFile(lock, 'utf8').catch((recoveryFailure) => {
        if ((recoveryFailure as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw recoveryFailure;
      });
      let stale = false;
      if (observed !== undefined) {
        try {
          const record = JSON.parse(observed) as Record<string, unknown>;
          stale =
            record?.schemaVersion === 1 &&
            Number.isSafeInteger(record.pid) &&
            (record.pid as number) > 0 &&
            typeof record.nonce === 'string' &&
            record.nonce.length > 0 &&
            !processExists(record.pid as number);
        } catch {}
      }
      if (stale) {
        const guardOwner = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID() })}\n`;
        try {
          await publishOwner(recoveryGuard, guardOwner);
          try {
            if ((await readFile(lock, 'utf8').catch(() => undefined)) === observed) {
              const claim = `${lock}.recovery-${randomUUID()}`;
              try {
                await rename(lock, claim);
                if ((await readFile(claim, 'utf8').catch(() => undefined)) !== observed) {
                  fail(lockedCode, lockedMessage);
                }
                await rm(claim);
              } catch (recoveryFailure) {
                if ((recoveryFailure as NodeJS.ErrnoException).code !== 'ENOENT') {
                  throw recoveryFailure;
                }
              }
            }
          } finally {
            await releaseExactOwner(recoveryGuard, guardOwner, 'release');
          }
          continue;
        } catch (guardFailure) {
          if ((guardFailure as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw guardFailure;
          }
        }
      }
      if (Date.now() >= deadline) {
        fail(lockedCode, lockedMessage);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
async function acquireSelectorLock(directory: string): Promise<() => Promise<void>> {
  return acquireAtomicOwnerLock(
    path.join(directory, 'active-release.lock'),
    'INSTALL_SELECTOR_LOCKED',
    'Another process owns the active release selector lock.',
  );
}
async function replaceActiveRelease(
  localAppData: string,
  expectedReleaseKey: string | null,
  releaseKey: string | null,
): Promise<void> {
  if (releaseKey !== null && !SHA.test(releaseKey)) {
    fail('INSTALL_SELECTOR_INVALID', 'Release key is invalid.');
  }
  const directory = path.join(localAppData, 'mpx'),
    release = await acquireSelectorLock(directory);
  try {
    if ((await observeActiveRelease(localAppData)) !== expectedReleaseKey) {
      fail(
        'INSTALL_FOREIGN_OR_DRIFTED',
        'Refusing to replace a foreign or drifted active release selector.',
      );
    }
    const file = path.join(directory, 'active-release');
    if (releaseKey === null) {
      await rm(file);
      return;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${releaseKey}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  } finally {
    await release();
  }
}
export async function activateRelease(
  localAppData: string,
  expectedPriorReleaseKey: string | null,
  releaseKey: string,
): Promise<() => Promise<void>> {
  await replaceActiveRelease(localAppData, expectedPriorReleaseKey, releaseKey);
  return () => replaceActiveRelease(localAppData, releaseKey, expectedPriorReleaseKey);
}
export async function readActiveRelease(localAppData: string): Promise<string> {
  return (
    (await observeActiveRelease(localAppData)) ??
    fail('INSTALL_SELECTOR_UNAVAILABLE', 'Active release selector is unavailable.')
  );
}
