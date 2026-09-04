import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import { parseUserConfig } from '@mpx/config';
import {
  ManagedLauncherAdapter,
  OwnedJsonResourceAdapter,
  ProductionWindowsResourceStore,
  type BinaryFileSystem,
  type JsonResourceStore,
  type ManagedLauncherSpec,
  type OwnedResourceSpec,
  type PriorOwnedResourceAuthorization,
} from '@mpx/windows';
import {
  canonicalJson,
  installerDigest,
  type InstallIntentV1,
  type InstallOperationV1,
  type OwnershipReceiptV1,
  type ReleaseManifestV1,
} from './immutable-core.js';
import {
  buildStableNodeEntryBody,
  buildStableSelectorBody,
  buildWindowsIntegrationSpecs,
} from './windows-integration.js';
import {
  verifyAccountEnrollment,
  verifyRuntimeRegistrationMatrix,
  type AccountProbeV1,
  type RegisteredRuntime,
  type RuntimeIdentity,
  type RuntimeRegistrationMatrixV1,
  type RuntimeRegistrationObservationV1,
} from './runtime-registration.js';
import type { InstallerOperationAdapter, InstallerOperationSet } from './orchestration.js';
import { withInstallerCleanup } from './failure.js';

const missing = (failure: unknown): boolean => (failure as NodeJS.ErrnoException).code === 'ENOENT';
function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
const sha = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');

interface BinaryCreateOperations {
  open(target: string, flags: 'wx'): Promise<Pick<FileHandle, 'writeFile' | 'sync' | 'close'>>;
  link(existingPath: string, newPath: string): Promise<void>;
}
const binaryCreateOperations: BinaryCreateOperations = {
  open: (target, flags) => open(target, flags),
  link,
};

export class NodeBinaryFileSystem implements BinaryFileSystem {
  private readonly createOperations: BinaryCreateOperations;
  constructor(createOperations: Partial<BinaryCreateOperations> = {}) {
    this.createOperations = { ...binaryCreateOperations, ...createOperations };
  }
  async read(target: string): Promise<Buffer | undefined> {
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) {
        fail('INSTALL_TARGET_UNSAFE', 'Installer file target is unsafe.');
      }
      return readFile(target);
    } catch (failure) {
      if (missing(failure)) {
        return undefined;
      }
      throw failure;
    }
  }
  async create(target: string, body: Buffer): Promise<boolean> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    return withInstallerCleanup(
      async () => {
        const handle = await this.createOperations.open(temporary, 'wx');
        try {
          await handle.writeFile(body);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await this.createOperations.link(temporary, target);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'EEXIST') {
            return false;
          }
          throw failure;
        }
        return true;
      },
      () => rm(temporary, { force: true }),
      'File creation and temporary cleanup both failed.',
    );
  }
  async write(target: string, body: Buffer): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await withInstallerCleanup(
      async () => {
        await writeFile(temporary, body, { flag: 'wx' });
        await rename(temporary, target);
      },
      () => rm(temporary, { force: true }),
      'File replacement and temporary cleanup both failed.',
    );
  }
  async remove(target: string): Promise<void> {
    await rm(target, { force: true });
  }
}

/** File-backed host used by JSON integration tests. Native stores can be injected by the CLI. */
export class NodeJsonResourceStore implements JsonResourceStore {
  private assertFile(target: string): void {
    if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.json') {
      fail(
        'INSTALL_ADAPTER_UNSUPPORTED',
        'A typed native Windows resource adapter is required for this target.',
      );
    }
  }
  async read(target: string): Promise<unknown | undefined> {
    this.assertFile(target);
    try {
      return parseStrictJson(await readFile(target, 'utf8'));
    } catch (failure) {
      if (missing(failure)) {
        return undefined;
      }
      throw failure;
    }
  }
  async write(target: string, value: unknown): Promise<void> {
    this.assertFile(target);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async remove(target: string): Promise<void> {
    this.assertFile(target);
    await rm(target, { force: true });
  }
}

export interface RuntimeRegistrationInspectionPort {
  inspect(
    intent: InstallIntentV1,
    priorReceipt?: OwnershipReceiptV1,
  ): Promise<{
    readonly observations: readonly RuntimeRegistrationObservationV1[];
    readonly accountProbes: readonly AccountProbeV1[];
    readonly mcpSharing: Readonly<Record<RuntimeIdentity, 'shared' | 'isolated'>>;
    readonly staticMcpIssues?: readonly string[];
    readonly staticMcpAbsent?: readonly string[];
    readonly runtimeIssues?: readonly string[];
  }>;
}
export class ReadOnlyRuntimeRegistrationInspector implements RuntimeRegistrationInspectionPort {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async inspect(intent: InstallIntentV1, priorReceipt?: OwnershipReceiptV1) {
    const matrix =
      intent.runtimeRegistrations ??
      fail('INSTALL_SCHEMA_INVALID', 'Runtime registration intent is required.');
    const observations: RuntimeRegistrationObservationV1[] = [],
      accountProbes: AccountProbeV1[] = [],
      runtimeIssues: string[] = [];
    const mcpSharing = {} as Record<RuntimeIdentity, 'shared' | 'isolated'>;
    for (const registration of matrix.registrations) {
      const key = registration.identity.replace('-', '_').toUpperCase(),
        nativeRoot = this.environment[`MPX_${key}_ROOT`],
        projectionRoot = this.environment[`MPX_${key}_PROJECTION_ROOT`];
      let enrolled = false;
      if (nativeRoot && path.isAbsolute(nativeRoot)) {
        const info = await lstat(nativeRoot).catch(() => undefined);
        enrolled = Boolean(
          info?.isDirectory() &&
          !info.isSymbolicLink() &&
          installerDigest(
            path.win32
              .normalize(nativeRoot)
              .replace(/[\\]+$/u, '')
              .toLowerCase(),
          ) === registration.nativeRootDigest,
        );
      }
      accountProbes.push({
        identity: registration.identity,
        runtime: registration.runtime,
        domain: registration.domain,
        nativeRootDigest: registration.nativeRootDigest,
        status: enrolled ? 'enrolled' : 'unavailable',
        accountLabel: `${registration.domain}:safe-root-metadata`,
      });
      mcpSharing[registration.identity] = registration.routes.mcpSharing;
      const executableInfo = await lstat(registration.executable.path).catch(() => undefined);
      if (!executableInfo) {
        continue;
      }
      if (
        !executableInfo.isFile() ||
        executableInfo.isSymbolicLink() ||
        sha(await readFile(registration.executable.path)) !== registration.executable.sha256
      ) {
        runtimeIssues.push(`executable-drift:${registration.identity}`);
        continue;
      }
      const effectiveProjectionRoot =
        projectionRoot && path.isAbsolute(projectionRoot)
          ? projectionRoot
          : path.join(
              this.environment.LOCALAPPDATA ?? '',
              'mpx',
              'runtime-projections',
              intent.releaseKey,
              registration.identity,
            );
      let missingFiles = 0,
        drifted = false;
      for (const file of registration.projection.files) {
        const candidate = path.join(effectiveProjectionRoot, ...file.path.split('/'));
        const info = await lstat(candidate).catch(() => undefined);
        if (!info) {
          missingFiles += 1;
          continue;
        }
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size !== file.bytes ||
          sha(await readFile(candidate)) !== file.sha256
        ) {
          drifted = true;
          break;
        }
      }
      const receiptTarget = path.join(
        this.environment.LOCALAPPDATA ?? '',
        'mpx',
        'installer',
        'registrations',
        `${registration.identity}.json`,
      );
      const receipt = await readFile(receiptTarget, 'utf8').catch(() => undefined);
      if (receipt !== undefined) {
        let parsed: unknown;
        try {
          parsed = parseStrictJson(receipt);
        } catch {
          parsed = null;
        }
        const desiredReceipt = {
            schemaVersion: 1,
            kind: 'runtime-registration-receipt',
            releaseKey: intent.releaseKey,
            registration,
          },
          priorRegistration = priorReceipt?.installIntent?.runtimeRegistrations?.registrations.find(
            (candidate) => candidate.identity === registration.identity,
          ),
          priorRegistrationReceipt = priorRegistration
            ? {
                schemaVersion: 1,
                kind: 'runtime-registration-receipt',
                releaseKey: priorReceipt!.releaseKey,
                registration: priorRegistration,
              }
            : undefined;
        if (
          canonicalJson(parsed) !== canonicalJson(desiredReceipt) &&
          (!priorRegistrationReceipt ||
            canonicalJson(parsed) !== canonicalJson(priorRegistrationReceipt))
        ) {
          runtimeIssues.push(`registration-drift:${registration.identity}`);
        }
      }
      if (drifted || (missingFiles > 0 && missingFiles < registration.projection.files.length)) {
        runtimeIssues.push(`projection-drift:${registration.identity}`);
      } else if (missingFiles === 0 && receipt !== undefined) {
        observations.push({
          identity: registration.identity,
          executable: registration.executable,
          projection: registration.projection,
        });
      }
    }
    const staticMcpIssues: string[] = [],
      staticMcpAbsent: string[] = [];
    for (const registration of intent.staticMcpRegistrations ?? []) {
      const target = path.join(
          this.environment.LOCALAPPDATA ?? '',
          'mpx',
          'installer',
          'mcp',
          `${registration.label.replace(':', '-')}.json`,
        ),
        body = await readFile(target, 'utf8').catch(() => undefined);
      if (body === undefined) {
        staticMcpAbsent.push(registration.label);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parseStrictJson(body);
      } catch {
        parsed = null;
      }
      if (canonicalJson(parsed) !== canonicalJson(registration)) {
        staticMcpIssues.push(`static-mcp-drift:${registration.label}`);
      }
    }
    return {
      observations,
      accountProbes,
      mcpSharing,
      staticMcpIssues,
      staticMcpAbsent,
      runtimeIssues,
    };
  }
}
export interface ProductionInstallerResources {
  readonly files: BinaryFileSystem;
  readonly resources: JsonResourceStore;
  readonly runtimeRegistrations?: RuntimeRegistrationInspectionPort;
}
class RoutedProductionResourceStore implements JsonResourceStore {
  constructor(
    private readonly files: JsonResourceStore,
    private readonly native: JsonResourceStore,
  ) {}
  private store(target: string): JsonResourceStore {
    return path.extname(target).toLowerCase() === '.json' ? this.files : this.native;
  }
  read(target: string): Promise<unknown | undefined> {
    return this.store(target).read(target);
  }
  write(target: string, value: unknown): Promise<void> {
    return this.store(target).write(target, value);
  }
  remove(target: string): Promise<void> {
    return this.store(target).remove(target);
  }
}
export function createProductionInstallerResources(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ProductionInstallerResources {
  const files = new NodeBinaryFileSystem(),
    json = new NodeJsonResourceStore();
  if (platform !== 'win32') {
    return {
      files,
      resources: json,
      runtimeRegistrations: new ReadOnlyRuntimeRegistrationInspector(environment),
    };
  }
  const native = new ProductionWindowsResourceStore({ platform });
  return {
    files,
    resources: new RoutedProductionResourceStore(json, native),
    runtimeRegistrations: new ReadOnlyRuntimeRegistrationInspector(environment),
  };
}

function expectedEnvironmentAfterApply(
  prior: unknown | undefined,
  desired: Readonly<Record<string, unknown>>,
): unknown {
  const previous =
      prior && typeof prior === 'object' && !Array.isArray(prior)
        ? (prior as Record<string, unknown>)
        : {},
    expected = Object.fromEntries(
      Object.entries(previous).filter(
        ([key]) => key !== 'owner' && key !== 'PathPrepend' && !key.startsWith('MPX_'),
      ),
    );
  for (const [key, value] of Object.entries(desired)) {
    if (key !== 'Path') {
      expected[key] = value;
    }
  }
  if (typeof desired.PathPrepend === 'string') {
    const entries =
      typeof previous.Path === 'string'
        ? previous.Path.split(';').filter(
            (entry) => entry !== previous.PathPrepend && entry !== desired.PathPrepend,
          )
        : [];
    expected.Path = [desired.PathPrepend, ...entries].join(';');
  }
  return expected;
}

function registeredRuntimeExecutableEnvironment(
  matrix: RuntimeRegistrationMatrixV1 | undefined,
): NodeJS.ProcessEnv {
  if (!matrix) {
    return {};
  }
  const variableByRuntime: Record<RegisteredRuntime, string> = {
    claude: 'MPX_CLAUDE_EXECUTABLE',
    pi: 'MPX_PI_EXECUTABLE',
  };
  return Object.fromEntries(
    (['claude', 'pi'] as const).flatMap((runtime) => {
      const registrations = matrix.registrations.filter(
        (registration) => registration.runtime === runtime,
      );
      const first = registrations[0]?.executable;
      if (!first) {
        return [];
      }
      if (
        registrations.some(
          ({ executable }) =>
            path.win32.normalize(executable.path).toLowerCase() !==
              path.win32.normalize(first.path).toLowerCase() ||
            executable.sha256 !== first.sha256 ||
            executable.version !== first.version,
        )
      ) {
        fail(
          'INSTALL_REGISTRATION_EXECUTABLE_AMBIGUOUS',
          `Runtime registrations disagree on the ${runtime} executable.`,
        );
      }
      return [[variableByRuntime[runtime], first.path]];
    }),
  );
}

interface Entry {
  operation: InstallOperationV1;
  launcher?: ManagedLauncherSpec;
  resource?: OwnedResourceSpec;
  priorOwned?: PriorOwnedResourceAuthorization;
  fileBody?: Buffer;
  fileSource?: string;
  expectedBytes?: number;
  appliedFileState?: Buffer | null;
  createOnly?: boolean;
  retainOnUninstall?: boolean;
}
export class ProductionInstallerOperationAdapter implements InstallerOperationAdapter {
  readonly name = 'windows-production';
  private readonly launchers: ManagedLauncherAdapter;
  private readonly owned: OwnedJsonResourceAdapter;
  private readonly files: BinaryFileSystem;
  private readonly runtimeRegistrations: RuntimeRegistrationInspectionPort | undefined;
  private readonly resources: JsonResourceStore;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly entries = new Map<string, Entry>();
  constructor(
    environment: NodeJS.ProcessEnv,
    private readonly currentUser: string,
    resources: ProductionInstallerResources = createProductionInstallerResources(
      process.platform,
      environment,
    ),
  ) {
    this.environment = { ...environment };
    this.files = resources.files;
    this.resources = resources.resources;
    this.launchers = new ManagedLauncherAdapter(resources.files);
    this.owned = new OwnedJsonResourceAdapter(resources.resources);
    this.runtimeRegistrations = resources.runtimeRegistrations;
  }
  async operations(
    intent: InstallIntentV1,
    manifest: ReleaseManifestV1,
    requireActual = false,
    priorReceipt?: OwnershipReceiptV1,
  ): Promise<InstallerOperationSet> {
    let userConfigEntry: Entry | undefined;
    if (intent.userConfigArtifact) {
      parseUserConfig(intent.userConfigArtifact.content, this.environment);
      const appData = this.environment.APPDATA;
      if (!appData || !path.win32.isAbsolute(appData)) {
        fail(
          'INSTALL_MUTABLE_ROOT_UNAVAILABLE',
          'APPDATA is required for the user-config artifact.',
        );
      }
      const target = path.win32.join(appData, 'mpx', 'config.json'),
        body = Buffer.from(intent.userConfigArtifact.content, 'utf8');
      if (sha(body) !== intent.userConfigArtifact.sha256) {
        fail('INSTALL_SCHEMA_INVALID', 'User-config artifact digest is invalid.');
      }
      const existing = await this.files.read(target);
      if (existing && !existing.equals(body) && !requireActual) {
        fail(
          'INSTALL_FOREIGN_OR_DRIFTED',
          'Refusing to replace different existing user-config bytes.',
        );
      }
      userConfigEntry = {
        fileBody: body,
        createOnly: true,
        retainOnUninstall: true,
        operation: {
          id: '01-user-config',
          adapter: this.name,
          action: 'ensure',
          target,
          desiredDigest: intent.userConfigArtifact.sha256,
        },
      };
    }
    if (intent.runtimeRegistrations) {
      if (!this.runtimeRegistrations) {
        fail(
          'INSTALL_REGISTRATION_INSPECTION_UNAVAILABLE',
          'Runtime registration actual-state inspection is required.',
        );
      }
      const inspection = await this.runtimeRegistrations.inspect(
          intent,
          requireActual ? undefined : priorReceipt,
        ),
        registration = verifyRuntimeRegistrationMatrix(
          intent.runtimeRegistrations,
          inspection.observations,
        ),
        enrollment = verifyAccountEnrollment(intent.runtimeRegistrations, inspection.accountProbes);
      const sharingIssues = intent.runtimeRegistrations.registrations
        .filter((item) => inspection.mcpSharing[item.identity] !== item.routes.mcpSharing)
        .map((item) => `mcp-sharing-drift:${item.identity}`);
      const unavailable = new Set(
        inspection.accountProbes
          .filter((probe) => probe.status === 'unavailable')
          .map((probe) => probe.identity),
      );
      const issues = [
        ...registration.issues.filter(
          (issue) => requireActual || !issue.startsWith('observation-missing:'),
        ),
        ...enrollment.issues.filter(
          (issue) =>
            !issue.startsWith('account-not-enrolled:') ||
            !unavailable.has(issue.slice('account-not-enrolled:'.length) as RuntimeIdentity),
        ),
        ...sharingIssues,
        ...(inspection.staticMcpIssues ?? []),
        ...(requireActual
          ? (inspection.staticMcpAbsent ?? []).map((label) => `static-mcp-missing:${label}`)
          : []),
        ...(inspection.runtimeIssues ?? []),
      ];
      if (issues.length) {
        fail(
          'INSTALL_REGISTRATION_UNHEALTHY',
          `Runtime registration actual state is unhealthy: ${issues.sort().join(',')}`,
        );
      }
    }
    const specs = buildWindowsIntegrationSpecs(
      {
        ...this.environment,
        ...registeredRuntimeExecutableEnvironment(intent.runtimeRegistrations),
      },
      this.currentUser,
      intent.releaseKey,
    );
    const cliEvidence = manifest.files.find((file) => file.path === 'bin/mpx.mjs');
    if (!cliEvidence) {
      fail('INSTALL_CLI_BUNDLE_MISSING', 'The immutable release has no bundled bin/mpx.mjs.');
    }
    const selectorBody = Buffer.from(buildStableSelectorBody(), 'utf8'),
      selectorTarget = path.win32.join(this.environment.MPX_APPS!, 'mpx', 'bin', 'mpx.cmd'),
      nodeEntryBody = Buffer.from(buildStableNodeEntryBody(), 'utf8'),
      nodeEntryTarget = path.win32.join(this.environment.MPX_APPS!, 'mpx', 'bin', 'mpx-node.mjs');
    const automatic: Entry[] = [
      ...(userConfigEntry ? [userConfigEntry] : []),
      {
        fileBody: selectorBody,
        operation: {
          id: '05-cli-selector',
          adapter: this.name,
          action: 'ensure',
          target: selectorTarget,
          desiredDigest: sha(selectorBody),
        },
      },
      {
        fileBody: nodeEntryBody,
        operation: {
          id: '06-node-entry',
          adapter: this.name,
          action: 'ensure',
          target: nodeEntryTarget,
          desiredDigest: sha(nodeEntryBody),
        },
      },
    ];
    for (const [index, launcher] of specs.launchers.entries()) {
      const plan = await this.launchers.plan(launcher),
        desiredDigest = sha(Buffer.from(plan.managedBase64, 'base64'));
      automatic.push({
        launcher,
        operation: {
          id: `10-profile-${index}`,
          adapter: this.name,
          action: 'ensure',
          target: launcher.path,
          desiredDigest,
        },
      });
    }
    const resources = [specs.environment, ...specs.shortcuts];
    for (const [index, resource] of resources.entries()) {
      const operation: InstallOperationV1 = {
        id: `${20 + index * 10}-${resource.kind}`,
        adapter: this.name,
        action: 'ensure',
        target: resource.target,
        desiredDigest: installerDigest(resource.desired),
      };
      const priorOwned =
        priorReceipt && priorReceipt.releaseKey !== intent.releaseKey
          ? this.priorOwnedAuthorization(priorReceipt, operation, resource)
          : undefined;
      automatic.push({
        resource,
        operation,
        ...(priorOwned ? { priorOwned } : {}),
      });
    }
    for (const [index, registration] of (
      intent.runtimeRegistrations?.registrations ?? []
    ).entries()) {
      const projectionBody = Buffer.from(
        `${canonicalJson({ schemaVersion: 1, kind: 'synthetic-runtime-projection', releaseKey: intent.releaseKey, identity: registration.identity, projection: registration.projection })}\n`,
        'utf8',
      );
      const projectionTarget = path.win32.join(
        this.environment.LOCALAPPDATA!,
        'mpx',
        'runtime-projections',
        intent.releaseKey,
        registration.identity,
        'projection.json',
      );
      automatic.push({
        fileBody: projectionBody,
        operation: {
          id: `60-projection-${registration.identity}-descriptor`,
          adapter: this.name,
          action: 'ensure',
          target: projectionTarget,
          desiredDigest: sha(projectionBody),
        },
      });
      for (const [fileIndex, file] of registration.projection.files.entries()) {
        const evidence = manifest.files.find((candidate) => candidate.path === file.path);
        if (!evidence || evidence.sha256 !== file.sha256 || evidence.bytes !== file.bytes) {
          fail(
            'INSTALL_PROJECTION_MISMATCH',
            `Runtime projection ${file.path} does not match the current release manifest.`,
          );
        }
        const target = path.win32.join(
          this.environment.LOCALAPPDATA!,
          'mpx',
          'runtime-projections',
          intent.releaseKey,
          registration.identity,
          ...file.path.split('/'),
        );
        const source = path.win32.join(
          this.environment.MPX_APPS!,
          'mpx',
          'releases',
          intent.releaseKey,
          ...file.path.split('/'),
        );
        automatic.push({
          fileSource: source,
          expectedBytes: file.bytes,
          operation: {
            id: `61-projection-${registration.identity}-${String(fileIndex).padStart(4, '0')}`,
            adapter: this.name,
            action: 'ensure',
            target,
            desiredDigest: file.sha256,
          },
        });
      }
      const receiptBody = Buffer.from(
        `${canonicalJson({ schemaVersion: 1, kind: 'runtime-registration-receipt', releaseKey: intent.releaseKey, registration })}\n`,
        'utf8',
      );
      const receiptTarget = path.win32.join(
        this.environment.LOCALAPPDATA!,
        'mpx',
        'installer',
        'registrations',
        `${registration.identity}.json`,
      );
      automatic.push({
        fileBody: receiptBody,
        operation: {
          id: `${70 + index}-registration-${registration.identity}`,
          adapter: this.name,
          action: 'ensure',
          target: receiptTarget,
          desiredDigest: sha(receiptBody),
        },
      });
    }
    for (const [index, registration] of (intent.staticMcpRegistrations ?? []).entries()) {
      const body = Buffer.from(`${canonicalJson(registration)}\n`, 'utf8'),
        safeLabel = registration.label.replace(':', '-');
      const target = path.win32.join(
        this.environment.LOCALAPPDATA!,
        'mpx',
        'installer',
        'mcp',
        `${safeLabel}.json`,
      );
      automatic.push({
        fileBody: body,
        operation: {
          id: `${74 + index}-registration-mcp-${safeLabel}`,
          adapter: this.name,
          action: 'ensure',
          target,
          desiredDigest: sha(body),
        },
      });
    }
    automatic.sort((left, right) => left.operation.id.localeCompare(right.operation.id));
    for (const entry of automatic) {
      this.entries.set(installerDigest(entry.operation), entry);
    }
    while (this.entries.size > 2_048) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    const references = (intent.externalIntegrations ?? []).map((integration) => ({
      id: integration.id,
      planDigest: integration.planDigest,
      verifierRef: integration.verifierRef,
    }));
    return {
      automatic: automatic.map((x) => x.operation),
      classifications: {
        automatic: automatic.map((x) => x.operation.id),
        confirmationRequired: references.filter(
          (_reference, index) =>
            intent.externalIntegrations![index]!.classification === 'confirmation-required',
        ),
        manualOnly: references.filter(
          (_reference, index) =>
            intent.externalIntegrations![index]!.classification === 'manual-only',
        ),
      },
    };
  }
  private priorOwnedAuthorization(
    receipt: OwnershipReceiptV1,
    operation: InstallOperationV1,
    resource: OwnedResourceSpec,
  ): PriorOwnedResourceAuthorization | undefined {
    const prior = receipt.operations.find((candidate) => candidate.id === operation.id),
      locator = receipt.operationLocators.find(
        (candidate) => candidate.operationId === operation.id,
      );
    if (
      !prior ||
      !locator ||
      prior.adapter !== operation.adapter ||
      locator.adapter !== operation.adapter ||
      prior.action !== 'ensure' ||
      operation.action !== 'ensure' ||
      prior.target !== operation.target ||
      prior.desiredDigest === null ||
      !locator.spec ||
      typeof locator.spec !== 'object' ||
      Array.isArray(locator.spec)
    ) {
      return undefined;
    }
    const durable = locator.spec as Record<string, unknown>;
    if (
      Object.keys(durable).sort().join('\0') !== 'kind\0spec' ||
      durable.kind !== 'resource' ||
      !durable.spec ||
      typeof durable.spec !== 'object' ||
      Array.isArray(durable.spec)
    ) {
      return undefined;
    }
    const priorSpec = durable.spec as Record<string, unknown>;
    if (
      Object.keys(priorSpec).sort().join('\0') !== 'desired\0kind\0ownershipKey\0target' ||
      priorSpec.kind !== resource.kind ||
      priorSpec.target !== resource.target ||
      priorSpec.ownershipKey !== resource.ownershipKey ||
      !priorSpec.desired ||
      typeof priorSpec.desired !== 'object' ||
      Array.isArray(priorSpec.desired) ||
      installerDigest(priorSpec.desired) !== prior.desiredDigest
    ) {
      return undefined;
    }
    return {
      kind: resource.kind,
      target: resource.target,
      ownershipKey: resource.ownershipKey,
      desiredDigest: prior.desiredDigest,
    };
  }
  async receiptLocator(operation: InstallOperationV1): Promise<unknown> {
    const entry = await this.entry(operation);
    if (entry.launcher) {
      return { kind: 'launcher', spec: entry.launcher };
    }
    if (entry.resource!) {
      return { kind: 'resource', spec: entry.resource };
    }
    if (entry.retainOnUninstall) {
      return { kind: 'user-config', retention: 'user-owned' };
    }
    return { kind: 'file' };
  }
  async hydrateReceiptOperation(operation: InstallOperationV1, locator: unknown): Promise<void> {
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
      fail('INSTALL_RECEIPT_AMBIGUOUS', `Invalid durable locator for ${operation.id}.`);
    }
    const value = locator as Record<string, unknown>,
      keys = Object.keys(value).sort().join('\0');
    const roots = [
      this.environment.MPX_APPS!,
      this.environment.APPDATA,
      this.environment.LOCALAPPDATA!,
      this.environment.USERPROFILE,
    ]
      .filter((root): root is string => Boolean(root))
      .map((root) => path.win32.resolve(root).toLowerCase());
    const target = path.win32.resolve(operation.target).toLowerCase(),
      assertFileTarget = () => {
        if (!roots.some((root) => target === root || target.startsWith(`${root}\\`))) {
          fail(
            'INSTALL_RECEIPT_FORGED',
            `Receipt target is outside configured ownership roots for ${operation.id}.`,
          );
        }
      };
    let entry: Entry;
    if (value.kind === 'file' && keys === 'kind') {
      assertFileTarget();
      entry = { operation, fileBody: Buffer.alloc(0) };
    } else if (
      value.kind === 'user-config' &&
      value.retention === 'user-owned' &&
      keys === 'kind\0retention'
    ) {
      const expectedTarget =
        this.environment.APPDATA && path.win32.join(this.environment.APPDATA, 'mpx', 'config.json');
      if (
        operation.id !== '01-user-config' ||
        !expectedTarget ||
        path.win32.resolve(operation.target).toLowerCase() !==
          path.win32.resolve(expectedTarget).toLowerCase() ||
        operation.action !== 'ensure' ||
        operation.desiredDigest === null
      ) {
        fail('INSTALL_RECEIPT_FORGED', `User-config locator does not bind ${operation.id}.`);
      }
      entry = { operation, fileBody: Buffer.alloc(0), createOnly: true, retainOnUninstall: true };
    } else if (
      value.kind === 'launcher' &&
      keys === 'kind\0spec' &&
      value.spec &&
      typeof value.spec === 'object' &&
      !Array.isArray(value.spec)
    ) {
      assertFileTarget();
      const launcher = value.spec as unknown as ManagedLauncherSpec;
      if (launcher.path !== operation.target) {
        fail('INSTALL_RECEIPT_FORGED', `Launcher locator does not bind ${operation.id}.`);
      }
      entry = { operation, launcher };
    } else if (
      value.kind === 'resource' &&
      keys === 'kind\0spec' &&
      value.spec &&
      typeof value.spec === 'object' &&
      !Array.isArray(value.spec)
    ) {
      const resource = value.spec as unknown as OwnedResourceSpec;
      const resourceKind = (resource as { kind?: unknown }).kind;
      if (resourceKind === 'terminal-profile' || resourceKind === 'scheduled-task') {
        const boundary =
          resourceKind === 'terminal-profile' ? 'Windows Terminal' : 'Scheduled capture';
        fail(
          'INSTALL_RECEIPT_AMBIGUOUS',
          `${boundary} is outside the production installer boundary for ${operation.id}.`,
        );
      }
      if (
        resource.target !== operation.target ||
        installerDigest(resource.desired) !== operation.desiredDigest
      ) {
        fail('INSTALL_RECEIPT_FORGED', `Native resource locator does not bind ${operation.id}.`);
      }
      entry = { operation, resource };
    } else {
      fail('INSTALL_RECEIPT_AMBIGUOUS', `Invalid durable locator for ${operation.id}.`);
    }
    this.entries.set(installerDigest(operation), entry);
  }
  async retainOnUninstall(operation: InstallOperationV1): Promise<boolean> {
    return (await this.entry(operation)).retainOnUninstall === true;
  }
  private async entry(operation: InstallOperationV1): Promise<Entry> {
    const exact = this.entries.get(installerDigest(operation));
    if (exact) {
      return exact;
    }
    if (operation.action === 'remove') {
      for (const entry of this.entries.values()) {
        if (entry.operation.id === operation.id && entry.operation.target === operation.target) {
          if (entry.resource && (await this.owned.inspect(entry.resource!)).status === 'owned') {
            return entry;
          }
          if (entry.fileBody || entry.fileSource || entry.launcher) {
            return entry;
          }
        }
      }
    }
    return fail('INSTALL_PLAN_STALE', `Unknown or stale production operation ${operation.id}.`);
  }
  async observe(operation: InstallOperationV1): Promise<string | null> {
    const entry = await this.entry(operation),
      target = operation.target;
    if (entry.fileBody || entry.fileSource) {
      const current = await this.files.read(target);
      return current ? sha(current) : null;
    }
    if (entry.launcher) {
      return (await this.launchers.inspect(entry.launcher)).digest;
    }
    return (await this.owned.inspect(entry.resource!)).digest;
  }
  async capture(operation: InstallOperationV1): Promise<string | null> {
    const entry = await this.entry(operation),
      target = operation.target;
    if (entry.fileBody || entry.fileSource || entry.launcher) {
      const current = await this.files.read(target);
      return current?.toString('base64') ?? null;
    }
    const current = await this.resources.read(target);
    return current === undefined ? null : Buffer.from(JSON.stringify(current)).toString('base64');
  }
  async apply(operation: InstallOperationV1): Promise<void> {
    const entry = await this.entry(operation);
    if (entry.fileBody || entry.fileSource) {
      if (operation.action === 'remove') {
        entry.appliedFileState = null;
        await this.files.remove(operation.target);
      } else {
        const body = entry.fileBody ?? (await this.files.read(entry.fileSource!));
        if (
          !body ||
          (body.length !== entry.expectedBytes && entry.expectedBytes !== undefined) ||
          sha(body) !== operation.desiredDigest
        ) {
          fail(
            'INSTALL_RELEASE_PROJECTION_DRIFT',
            `Immutable projection source changed for ${operation.id}.`,
          );
        }
        entry.appliedFileState = Buffer.from(body);
        if (entry.createOnly) {
          if (await this.files.create(operation.target, body)) {
            return;
          }
          const current = await this.files.read(operation.target);
          if (!current?.equals(body)) {
            fail(
              'INSTALL_FOREIGN_OR_DRIFTED',
              `Refusing to replace different existing bytes for ${operation.id}.`,
            );
          }
          return;
        }
        await this.files.write(operation.target, body);
      }
      return;
    }
    if (operation.action === 'remove') {
      if (entry.launcher) {
        const plan = await this.launchers.plan(entry.launcher);
        entry.appliedFileState = null;
        if (plan.previousManagedBase64 === null) {
          return;
        }
        await this.launchers.remove({
          schemaVersion: 1,
          kind: 'managed-launcher-receipt',
          target: entry.launcher.path,
          shell: entry.launcher.shell,
          managedBase64: plan.previousManagedBase64,
          previousManagedBase64: null,
        });
      } else {
        const plan = await this.owned.plan(entry.resource!);
        if (plan.inspection.status === 'absent') {
          return;
        }
        await this.owned.remove({
          schemaVersion: 1,
          kind: 'owned-resource-receipt',
          spec: entry.resource!,
          desiredDigest: installerDigest(entry.resource!.desired),
        });
      }
      return;
    }
    if (entry.launcher) {
      const launcherPlan = await this.launchers.plan(entry.launcher);
      entry.appliedFileState = Buffer.from(launcherPlan.outputBase64, 'base64');
      await this.launchers.apply(launcherPlan);
    } else {
      await this.owned.apply(await this.owned.plan(entry.resource!), entry.priorOwned);
    }
  }
  async restore(operation: InstallOperationV1, snapshot: string | null): Promise<void> {
    const entry = await this.entry(operation),
      target = operation.target;
    if (entry.fileBody || entry.fileSource || entry.launcher) {
      const current = await this.files.read(target),
        prior = snapshot === null ? undefined : Buffer.from(snapshot, 'base64');
      if (
        (!current && !prior) ||
        (current !== undefined && prior !== undefined && current.equals(prior))
      ) {
        return;
      }
      const appliedStateIsCurrent =
        entry.appliedFileState === null
          ? current === undefined
          : entry.appliedFileState !== undefined
            ? current !== undefined && current.equals(entry.appliedFileState)
            : operation.action === 'remove'
              ? current === undefined
              : current !== undefined && sha(current) === operation.desiredDigest;
      if (!appliedStateIsCurrent) {
        fail(
          'INSTALL_FOREIGN_OR_DRIFTED',
          `Refusing to restore over foreign or drifted bytes for ${operation.id}.`,
        );
      }
      if (prior === undefined) {
        await this.files.remove(target);
      } else {
        await this.files.write(target, prior);
      }
      return;
    }
    const prior =
        snapshot === null
          ? undefined
          : JSON.parse(Buffer.from(snapshot, 'base64').toString('utf8')),
      current = await this.resources.read(target),
      priorDigest = prior === undefined ? null : installerDigest(prior),
      currentDigest = current === undefined ? null : installerDigest(current);
    if (currentDigest === priorDigest) {
      return;
    }
    if (entry.resource!.kind === 'user-environment') {
      const priorRecord =
          prior && typeof prior === 'object' && !Array.isArray(prior)
            ? (prior as Record<string, unknown>)
            : {},
        appliedDigests = new Set([
          installerDigest({ ...priorRecord, ...entry.resource!.desired }),
          installerDigest(expectedEnvironmentAfterApply(prior, entry.resource!.desired)),
        ]);
      if (currentDigest === null || !appliedDigests.has(currentDigest)) {
        fail(
          'INSTALL_FOREIGN_OR_DRIFTED',
          'Refusing to restore over a foreign or drifted native resource.',
        );
      }
    } else {
      const inspection = await this.owned.inspect(entry.resource!);
      if (
        inspection.status !== 'owned' ||
        inspection.digest !== installerDigest(entry.resource!.desired)
      ) {
        fail(
          'INSTALL_FOREIGN_OR_DRIFTED',
          'Refusing to restore over a foreign or drifted native resource.',
        );
      }
    }
    if (snapshot === null) {
      await this.owned.remove({
        schemaVersion: 1,
        kind: 'owned-resource-receipt',
        spec: entry.resource!,
        desiredDigest: installerDigest(entry.resource!.desired),
      });
    } else {
      await this.resources.write(target, prior);
    }
  }
}
