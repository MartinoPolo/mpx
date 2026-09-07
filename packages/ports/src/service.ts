import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { MpxError, parseStrictJson, sha256Canonical, type JsonValue } from '@mpx/core';
import { discoverProjectConfig, type ProjectConfig } from '@mpx/config';
import type {
  GitWorktreeAdapter,
  PortHold,
  PortPlatformAdapter,
  WorktreeIdentity,
} from './adapters.js';
import { allocatePortMap, buildPortFamilies, type PortServiceDefinition } from './arithmetic.js';
import { type LeaseRecord, type RegistryState, RegistryStore } from './registry.js';

export interface PortWarning {
  code: string;
  message: string;
  port?: number;
}
export interface EnsureRequest {
  cwd: string;
  projectRoot?: string;
  config: ProjectConfig;
  configHash: string;
}
export interface EnsureResult {
  lease: LeaseRecord;
  warnings: PortWarning[];
}
export interface LeaseFile {
  schemaVersion: 1;
  leaseId: string;
  projectId: string;
  worktreeId: string;
  configHash: string;
  services: Record<string, number>;
}
export interface ResolvedLease extends LeaseFile {
  readonly ownerRoot: string;
}
export interface RebuildRequest {
  roots: string[];
}
export interface RebuildResult {
  discovered: number;
  rebuilt: number;
  roots: number;
}
export interface LeaseReleaseIdentity {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly role: 'linked';
  readonly configHash: string;
  readonly gitAdminPath?: string;
  readonly commonGitPath?: string;
}
export interface LinkedReleaseRequest {
  repositoryCwd: string;
  identity: LeaseReleaseIdentity;
  projectionTombstonePath?: string;
}
export interface LinkedReleaseResult {
  released: boolean;
  identity: LeaseReleaseIdentity;
}
export interface ReconcileResult {
  removed: string[];
  repaired: string[];
  orphaned: LeaseReleaseIdentity[];
}
export interface PortServiceDependencies {
  store: RegistryStore;
  git: GitWorktreeAdapter;
  platform: PortPlatformAdapter;
  createId?: () => string;
  now?: () => number;
  writeLeaseFile?: (file: string, value: string) => Promise<void>;
}
interface RebuildCandidate {
  projection: LeaseFile;
  config: ProjectConfig;
  configHash: string;
  identity: WorktreeIdentity;
  definitions: PortServiceDefinition[];
}

function definitions(config: ProjectConfig): PortServiceDefinition[] {
  return Object.entries(config.development?.services ?? {}).map(([name, service]) => {
    if (service.port.preferred === undefined) {
      throw new MpxError({
        code: service.port.mode === 'managed' ? 'PORT_ANCHOR_REQUIRED' : 'PORT_PREFERRED_REQUIRED',
        message: `Service ${name} requires a preferred port.`,
      });
    }
    return {
      name,
      preferred: service.port.preferred,
      mode: service.port.mode,
      scope: service.scope,
      ...(service.port.family === undefined ? {} : { family: service.port.family }),
    };
  });
}
function localShape(lease: LeaseRecord): LeaseFile {
  return {
    schemaVersion: 1,
    leaseId: lease.leaseId,
    projectId: lease.projectId,
    worktreeId: lease.worktreeId,
    configHash: lease.configHash,
    services: lease.services,
  };
}
function sameMap(a: Record<string, number>, b: Record<string, number>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}
function sameProjection(a: LeaseFile, b: LeaseFile): boolean {
  return (
    a.leaseId === b.leaseId &&
    a.projectId === b.projectId &&
    a.worktreeId === b.worktreeId &&
    a.configHash === b.configHash &&
    sameMap(a.services, b.services)
  );
}
function sameLease(a: LeaseRecord, b: LeaseRecord): boolean {
  const normalize = (lease: LeaseRecord): LeaseRecord => ({
    ...lease,
    services: Object.fromEntries(
      Object.entries(lease.services).sort(([left], [right]) => left.localeCompare(right)),
    ),
    claims: [...lease.claims].sort((left, right) => left.port - right.port),
  });
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function releaseIdentity(lease: LeaseRecord): LeaseReleaseIdentity {
  if (lease.role !== 'linked') {
    throw new MpxError({
      code: 'PORT_LINKED_LEASE_REQUIRED',
      message: 'A linked worktree lease is required.',
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    leaseId: lease.leaseId,
    projectId: lease.projectId,
    repositoryId: lease.repositoryId,
    worktreeId: lease.worktreeId,
    worktreePath: lease.worktreePath,
    role: 'linked',
    configHash: lease.configHash,
    ...(lease.gitAdminPath ? { gitAdminPath: lease.gitAdminPath } : {}),
    ...(lease.commonGitPath ? { commonGitPath: lease.commonGitPath } : {}),
  });
}
function sameReleaseIdentity(lease: LeaseRecord, identity: LeaseReleaseIdentity): boolean {
  if (identity.schemaVersion !== 1 || identity.role !== 'linked') {
    return false;
  }
  const expected = releaseIdentity(lease);
  return (
    Object.keys(expected).length === Object.keys(identity).length &&
    Object.entries(expected).every(
      ([key, value]) => identity[key as keyof LeaseReleaseIdentity] === value,
    )
  );
}
function validReleaseIdentity(identity: LeaseReleaseIdentity): boolean {
  const required = [
    'schemaVersion',
    'leaseId',
    'projectId',
    'repositoryId',
    'worktreeId',
    'worktreePath',
    'role',
    'configHash',
  ];
  const allowed = new Set([...required, 'gitAdminPath', 'commonGitPath']);
  const value = identity as unknown as Record<string, unknown>;
  return (
    value.schemaVersion === 1 &&
    value.role === 'linked' &&
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    [
      value.leaseId,
      value.projectId,
      value.repositoryId,
      value.worktreeId,
      value.worktreePath,
    ].every((item) => typeof item === 'string' && item.length > 0) &&
    typeof value.configHash === 'string' &&
    canonicalHashPattern.test(value.configHash) &&
    [value.gitAdminPath, value.commonGitPath].every(
      (item) => item === undefined || (typeof item === 'string' && item.length > 0),
    )
  );
}
function parseLeaseFile(value: JsonValue, code = 'PORT_LEASE_INVALID'): LeaseFile {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'configHash,leaseId,projectId,schemaVersion,services,worktreeId' ||
    value.schemaVersion !== 1 ||
    typeof value.leaseId !== 'string' ||
    value.leaseId.length === 0 ||
    typeof value.projectId !== 'string' ||
    value.projectId.length === 0 ||
    typeof value.worktreeId !== 'string' ||
    value.worktreeId.length === 0 ||
    typeof value.configHash !== 'string' ||
    !canonicalHashPattern.test(value.configHash) ||
    typeof value.services !== 'object' ||
    value.services === null ||
    Array.isArray(value.services) ||
    Object.entries(value.services).some(
      ([name, port]) =>
        name.length === 0 ||
        typeof port !== 'number' ||
        !Number.isSafeInteger(port) ||
        port < 1 ||
        port > 65_535,
    )
  ) {
    throw new MpxError({
      code,
      message:
        code === 'PORT_LEASE_INVALID'
          ? 'The local port lease has an invalid shape.'
          : 'A rebuild projection is malformed or inconsistent.',
    });
  }
  return value as unknown as LeaseFile;
}
function reservedPorts(state: RegistryState): Set<number> {
  return new Set(state.leases.flatMap(({ claims }) => claims.map(({ port }) => port)));
}
function validateLeaseSemantics(
  lease: LeaseRecord,
  config: ProjectConfig,
  main?: LeaseRecord,
): void {
  const defs = definitions(config);
  if ((lease.role === 'main' && lease.slot !== 0) || (lease.role === 'linked' && lease.slot < 1)) {
    throw new MpxError({
      code: 'PORT_LEASE_STALE',
      message: 'The lease has an invalid worktree slot.',
    });
  }
  if (
    Object.keys(lease.services).sort().join('\u0000') !==
    defs
      .map(({ name }) => name)
      .sort()
      .join('\u0000')
  ) {
    throw new MpxError({
      code: 'PORT_LEASE_STALE',
      message: 'The lease service set differs from configuration.',
    });
  }
  const expected: Record<string, number> = {};
  for (const definition of defs) {
    if (definition.mode === 'fixed-shared') {
      expected[definition.name] = definition.preferred;
    } else if (definition.scope === 'project') {
      expected[definition.name] =
        lease.role === 'main' ? definition.preferred : (main?.services[definition.name] ?? -1);
    }
  }
  for (const family of buildPortFamilies(defs)) {
    for (const definition of family.services) {
      expected[definition.name] = definition.preferred + lease.slot * family.width;
    }
  }
  if (!sameMap(expected, lease.services)) {
    throw new MpxError({
      code: 'PORT_LEASE_STALE',
      message: 'The lease assignment differs from current family arithmetic.',
    });
  }
  const expectedClaims = [
    ...defs
      .filter(
        ({ mode, scope }) => mode === 'managed' && (scope === 'checkout' || lease.role === 'main'),
      )
      .map(({ name }) => ({ port: expected[name]!, exclusive: true })),
    ...defs
      .filter(({ mode }) => mode === 'fixed-shared')
      .map(({ preferred }) => ({ port: preferred, exclusive: false })),
  ]
    .filter(
      (claim, index, claims) =>
        claims.findIndex(
          (candidate) => candidate.port === claim.port && candidate.exclusive === claim.exclusive,
        ) === index,
    )
    .sort(
      (left, right) => left.port - right.port || Number(right.exclusive) - Number(left.exclusive),
    );
  const actualClaims = [...lease.claims].sort(
    (left, right) => left.port - right.port || Number(right.exclusive) - Number(left.exclusive),
  );
  if (JSON.stringify(actualClaims) !== JSON.stringify(expectedClaims)) {
    throw new MpxError({
      code: 'PORT_LEASE_STALE',
      message: 'The lease claims differ from its configured services.',
    });
  }
}
const canonicalHashPattern = /^[0-9a-f]{64}$/u;
function validateRequestHash(request: EnsureRequest): void {
  if (request.configHash !== sha256Canonical(request.config as unknown as JsonValue)) {
    throw new MpxError({
      code: 'PORT_CONFIG_HASH_MISMATCH',
      message: 'The port request configuration hash is invalid.',
    });
  }
}
export class PortService {
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly writer: (file: string, value: string) => Promise<void>;
  constructor(private readonly dependencies: PortServiceDependencies) {
    this.createId = dependencies.createId ?? randomUUID;
    this.now = dependencies.now ?? Date.now;
    this.writer =
      dependencies.writeLeaseFile ??
      (async (file, value) => {
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(temporary, 'wx');
        try {
          await handle.writeFile(value, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
      });
  }
  async ensure(request: EnsureRequest): Promise<EnsureResult> {
    validateRequestHash(request);
    const current = await this.dependencies.git.identify(request.cwd);
    if (
      request.projectRoot &&
      path.normalize(await realpath(request.projectRoot)) !== path.normalize(current.path)
    ) {
      throw new MpxError({
        code: 'PORT_PROJECT_ROOT_MISMATCH',
        message: 'Port-managed configuration must be located at the Git worktree root.',
      });
    }
    const all = await this.dependencies.git.list(request.cwd);
    const holds: PortHold[] = [];
    const warnings: PortWarning[] = [];
    const mainIdentity = all.find(({ role }) => role === 'main');
    if (current.role === 'linked' && !mainIdentity) {
      throw new MpxError({
        code: 'PORT_MAIN_NOT_FOUND',
        message: 'Git did not report the main worktree.',
      });
    }
    let selected!: LeaseRecord,
      created = false,
      priorLease: LeaseRecord | undefined,
      priorProjection: { value: LeaseFile; bytes: string } | undefined;
    try {
      await this.dependencies.store.transaction(async (state) => {
        const allRepositoryLeases = state.leases.filter(
          (lease) => lease.repositoryId === current.repositoryId,
        );
        const repositoryLeases = allRepositoryLeases.filter(
          (lease) => lease.projectId === request.config.project.id,
        );
        const existingMain =
          current.role === 'linked'
            ? repositoryLeases.find(
                (lease) => lease.role === 'main' && lease.worktreeId === mainIdentity!.worktreeId,
              )
            : undefined;
        if (current.role === 'linked' && !existingMain) {
          throw new MpxError({
            code: 'PORT_MAIN_RESERVATION_REQUIRED',
            message:
              'Reserve ports in the current Git main worktree before reserving a linked worktree.',
          });
        }
        if (current.role === 'linked' && existingMain!.configHash !== request.configHash) {
          throw new MpxError({
            code: 'PORT_CONFIG_MISMATCH',
            message: 'The linked worktree config does not match the main port reservation.',
          });
        }
        const stable = state.leases.find(
          (lease) =>
            lease.repositoryId === current.repositoryId &&
            lease.worktreeId === current.worktreeId &&
            lease.projectId === request.config.project.id &&
            lease.configHash === request.configHash,
        );
        if (stable) {
          selected = stable;
          return;
        }
        const currentMainLease = allRepositoryLeases.find(
          (lease) => lease.role === 'main' && lease.worktreeId === current.worktreeId,
        );
        if (
          current.role === 'main' &&
          currentMainLease &&
          allRepositoryLeases.some((lease) => lease.role === 'linked') &&
          (currentMainLease.projectId !== request.config.project.id ||
            currentMainLease.configHash !== request.configHash)
        ) {
          throw new MpxError({
            code: 'PORT_CONFIG_MISMATCH',
            message:
              'Release linked leases before changing the main project or port configuration.',
          });
        }
        priorLease = state.leases.find(
          (lease) =>
            lease.repositoryId === current.repositoryId && lease.worktreeId === current.worktreeId,
        );
        if (priorLease) {
          priorProjection = await this.readProjectionSnapshot(
            path.join(current.path, '.worktree-ports.json'),
            priorLease,
          );
        }
        state.leases = state.leases.filter(
          (lease) =>
            lease.repositoryId !== current.repositoryId || lease.worktreeId !== current.worktreeId,
        );
        selected = await this.allocate(state, current, request, warnings, holds);
        created = true;
      });
    } finally {
      await Promise.all(holds.map((hold) => hold.release()));
    }
    let publicationFailure: unknown, compensationFailure: unknown;
    await this.dependencies.store.transaction(async (state) => {
      const authoritative = state.leases.find(({ leaseId }) => leaseId === selected.leaseId);
      if (!authoritative || !sameLease(authoritative, selected)) {
        throw new MpxError({
          code: 'PORT_ENSURE_SUPERSEDED',
          message:
            'The selected port lease was superseded before its projection could be published.',
          retryable: true,
        });
      }
      try {
        await this.writeProjection(authoritative);
      } catch (error) {
        publicationFailure = error;
        if (!created) {
          return;
        }
        try {
          await this.compensateProjection(authoritative, priorProjection);
        } catch (caught) {
          compensationFailure = caught;
        }
        const exact = state.leases.find((lease) => lease.leaseId === authoritative.leaseId);
        if (!exact || !sameLease(exact, authoritative)) {
          compensationFailure ??= new MpxError({
            code: 'PORT_COMPENSATION_CONFLICT',
            message: 'The newly created lease changed before compensation.',
          });
          return;
        }
        state.leases = priorLease
          ? state.leases.map((lease) => (lease === exact ? priorLease! : lease))
          : state.leases.filter((lease) => lease !== exact);
      }
    });
    if (compensationFailure) {
      throw new MpxError({
        code: 'PORT_ENSURE_COMPENSATION_FAILED',
        message:
          'Port projection publication failed and exact lease compensation could not be completed.',
        details: {
          originalCode: this.errorCode(publicationFailure),
          compensationCode: this.errorCode(compensationFailure),
        },
      });
    }
    if (publicationFailure) {
      throw publicationFailure;
    }
    return { lease: selected, warnings };
  }
  private async allocate(
    state: RegistryState,
    identity: WorktreeIdentity,
    request: EnsureRequest,
    warnings: PortWarning[],
    holds: PortHold[],
  ): Promise<LeaseRecord> {
    const defs = definitions(request.config);
    const managed = defs.filter(({ mode }) => mode === 'managed');
    const fixed = defs.filter(({ mode }) => mode === 'fixed-shared');
    const occupied = reservedPorts(state);
    for (const listener of await this.dependencies.platform.inspectListeners()) {
      occupied.add(listener.port);
    }
    let slot = identity.role === 'main' ? 0 : 1;
    if (identity.role === 'linked') {
      const usedSlots = new Set(
        state.leases
          .filter(
            (lease) => lease.repositoryId === identity.repositoryId && lease.role === 'linked',
          )
          .map(({ slot: usedSlot }) => usedSlot),
      );
      while (usedSlots.has(slot)) {
        slot += 1;
      }
    }
    const sharedManagedMap: Record<string, number> = {};
    const projectServices = new Set(
      managed.filter(({ scope }) => scope === 'project').map(({ name }) => name),
    );
    const projectMain = state.leases.find(
      (lease) =>
        lease.repositoryId === identity.repositoryId &&
        lease.projectId === request.config.project.id &&
        lease.configHash === request.configHash &&
        lease.role === 'main',
    );
    if (identity.role === 'linked' && projectMain && projectServices.size) {
      for (const name of projectServices) {
        if (projectMain.services[name] !== undefined) {
          sharedManagedMap[name] = projectMain.services[name]!;
        }
      }
    }
    const allocatable = managed.filter(({ name }) => !(name in sharedManagedMap));
    const fixedMap = Object.fromEntries(fixed.map(({ name, preferred }) => [name, preferred]));
    if (identity.role === 'linked') {
      for (const port of Object.values(fixedMap)) {
        occupied.add(port);
      }
    }
    for (const port of new Set(Object.values(fixedMap))) {
      if (state.leases.some(({ claims }) => claims.some((claim) => claim.port === port))) {
        warnings.push({
          code: 'FIXED_SHARED_DUPLICATE',
          message: `Fixed-shared port ${port} has another claim.`,
          port,
        });
      }
    }

    while (true) {
      let managedMap = { ...sharedManagedMap };
      if (allocatable.length) {
        managedMap = {
          ...managedMap,
          ...allocatePortMap(allocatable, slot, {
            occupied,
            advanceOnConflict: identity.role === 'linked',
          }),
        };
        const shifted = allocatable.find(({ scope }) => scope === 'checkout');
        if (shifted) {
          for (let candidate = slot; candidate <= 65_535; candidate++) {
            try {
              if (
                allocatePortMap(allocatable, candidate, { occupied })[shifted.name] ===
                managedMap[shifted.name]
              ) {
                slot = candidate;
                break;
              }
            } catch {
              /* rejected candidates precede the selected shared slot */
            }
          }
        }
      }

      const managedPorts = new Set(Object.values(managedMap));
      if (Object.values(fixedMap).some((port) => managedPorts.has(port))) {
        throw new MpxError({
          code: 'PORT_SERVICE_PORT_COLLISION',
          message: 'Managed and fixed-shared services resolve to the same port.',
        });
      }
      const services = Object.fromEntries(
        Object.entries({ ...managedMap, ...fixedMap }).sort(([a], [b]) => a.localeCompare(b)),
      );
      const exclusiveManaged = managed.filter(
        ({ name, scope }) =>
          scope === 'checkout' ||
          identity.role === 'main' ||
          !projectMain ||
          projectMain.services[name] !== services[name],
      );
      const claimPorts = exclusiveManaged
        .map(({ name }) => services[name]!)
        .filter((port, index, values) => values.indexOf(port) === index);
      try {
        if (claimPorts.length) {
          holds.push(await this.dependencies.platform.holdAvailablePorts(claimPorts));
        }
      } catch (error) {
        if (
          identity.role !== 'linked' ||
          !(error instanceof MpxError) ||
          error.code !== 'PORT_UNAVAILABLE'
        ) {
          throw error;
        }
        for (const port of claimPorts) {
          occupied.add(port);
        }
        slot += 1;
        continue;
      }
      const sharedClaimPorts = [...new Set(fixed.map(({ preferred }) => preferred))];
      const lease: LeaseRecord = {
        leaseId: this.createId(),
        projectId: request.config.project.id,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
        worktreePath: identity.path,
        role: identity.role,
        slot,
        configHash: request.configHash,
        services,
        claims: [
          ...claimPorts.map((port) => ({ port, exclusive: true })),
          ...sharedClaimPorts.map((port) => ({ port, exclusive: false })),
        ],
        updatedAt: this.now(),
        ...(identity.branch ? { branch: identity.branch } : {}),
        gitAdminPath: identity.gitAdminPath,
        commonGitPath: identity.commonGitPath,
      };
      state.leases.push(lease);
      return lease;
    }
  }
  private errorCode(error: unknown): string {
    return error instanceof MpxError ? error.code : 'COMMAND_FAILED';
  }
  private async readProjectionSnapshot(
    file: string,
    lease: LeaseRecord,
  ): Promise<{ value: LeaseFile; bytes: string } | undefined> {
    try {
      const status = await lstat(file);
      if (!status.isFile() || status.isSymbolicLink()) {
        return undefined;
      }
      const bytes = await readFile(file, 'utf8'),
        value = parseLeaseFile(parseStrictJson(bytes));
      return sameProjection(value, localShape(lease)) ? { value, bytes } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      return undefined;
    }
  }
  private async writeProjectionBytes(file: string, bytes: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.restore.tmp`,
      handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  private async compensateProjection(
    lease: LeaseRecord,
    prior: { value: LeaseFile; bytes: string } | undefined,
  ): Promise<void> {
    const file = path.join(lease.worktreePath, '.worktree-ports.json'),
      tombstone = `${file}.compensating-${randomUUID()}`;
    try {
      await rename(file, tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new MpxError({
          code: 'PORT_COMPENSATION_CONFLICT',
          message: 'The failed projection could not be inspected safely.',
        });
      }
      if (prior) {
        try {
          await this.writeProjectionBytes(file, prior.bytes);
        } catch {
          throw new MpxError({
            code: 'PORT_COMPENSATION_FAILED',
            message: 'The displaced projection could not be restored.',
          });
        }
      }
      return;
    }
    let observed: LeaseFile | undefined;
    try {
      const status = await lstat(tombstone);
      if (status.isFile() && !status.isSymbolicLink()) {
        observed = parseLeaseFile(parseStrictJson(await readFile(tombstone, 'utf8')));
      }
    } catch {
      observed = undefined;
    }
    const exact = observed !== undefined && sameProjection(observed, localShape(lease));
    const unchangedPrior =
      observed !== undefined && prior !== undefined && sameProjection(observed, prior.value);
    if (unchangedPrior) {
      try {
        await rename(tombstone, file);
        return;
      } catch {
        throw new MpxError({
          code: 'PORT_COMPENSATION_FAILED',
          message: 'The prior projection could not be restored.',
        });
      }
    }
    if (!exact) {
      try {
        await rename(tombstone, file);
      } catch {
        /* preserve the quarantine rather than overwrite a replacement */
      }
      throw new MpxError({
        code: 'PORT_COMPENSATION_CONFLICT',
        message: 'The failed projection no longer has the created lease identity.',
      });
    }
    try {
      if (prior) {
        await this.writeProjectionBytes(file, prior.bytes);
      }
      await rm(tombstone, { force: false });
    } catch {
      throw new MpxError({
        code: 'PORT_COMPENSATION_FAILED',
        message: 'The exact failed projection could not be compensated.',
      });
    }
  }
  private async writeProjection(lease: LeaseRecord): Promise<void> {
    await this.writer(
      path.join(lease.worktreePath, '.worktree-ports.json'),
      `${JSON.stringify(localShape(lease), null, 2)}\n`,
    );
  }
  async resolve(request: EnsureRequest): Promise<ResolvedLease> {
    validateRequestHash(request);
    const identity = await this.dependencies.git.identify(request.cwd);
    if (
      request.projectRoot &&
      path.normalize(await realpath(request.projectRoot)) !== path.normalize(identity.path)
    ) {
      throw new MpxError({
        code: 'PORT_PROJECT_ROOT_MISMATCH',
        message: 'Port-managed configuration must be located at the Git worktree root.',
      });
    }
    const all = await this.dependencies.git.list(request.cwd);
    const file = path.join(identity.path, '.worktree-ports.json');
    const mainIdentity = all.find(({ role }) => role === 'main');
    if (identity.role === 'linked' && !mainIdentity) {
      throw new MpxError({
        code: 'PORT_MAIN_NOT_FOUND',
        message: 'Git did not report the main worktree.',
      });
    }
    let value: JsonValue;
    try {
      const status = await lstat(file);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error('not regular');
      }
      value = parseStrictJson(await readFile(file, 'utf8'));
    } catch (error) {
      throw new MpxError({
        code: 'PORT_LEASE_INVALID',
        message: 'The local port lease is missing, malformed, or unsafe.',
        details: { cause: String(error) },
      });
    }
    const projection = parseLeaseFile(value);
    const registry = await this.dependencies.store.read();
    const lease = registry.leases.find(({ leaseId }) => leaseId === projection.leaseId);
    const matchingMain =
      identity.role === 'linked'
        ? registry.leases.find(
            (candidate) =>
              candidate.repositoryId === identity.repositoryId &&
              candidate.projectId === request.config.project.id &&
              candidate.role === 'main' &&
              candidate.worktreeId === mainIdentity!.worktreeId,
          )
        : undefined;
    if (identity.role === 'linked' && !matchingMain) {
      throw new MpxError({
        code: 'PORT_MAIN_RESERVATION_REQUIRED',
        message: 'The linked worktree requires a reservation from the current Git main worktree.',
      });
    }
    if (identity.role === 'linked' && matchingMain!.configHash !== request.configHash) {
      throw new MpxError({
        code: 'PORT_CONFIG_MISMATCH',
        message: 'The linked worktree config does not match the main port reservation.',
      });
    }
    if (
      !lease ||
      lease.repositoryId !== identity.repositoryId ||
      lease.worktreeId !== identity.worktreeId ||
      lease.projectId !== request.config.project.id ||
      lease.configHash !== request.configHash ||
      projection.projectId !== lease.projectId ||
      projection.worktreeId !== lease.worktreeId ||
      projection.configHash !== lease.configHash ||
      !sameMap(projection.services, lease.services)
    ) {
      throw new MpxError({
        code: 'PORT_LEASE_MISMATCH',
        message: 'The local lease does not match the authoritative registry.',
      });
    }
    validateLeaseSemantics(lease, request.config, matchingMain);
    return Object.freeze({
      ...localShape(lease),
      ownerRoot: path.resolve(mainIdentity?.path ?? identity.path),
    });
  }
  async list(): Promise<LeaseRecord[]> {
    return (await this.dependencies.store.read()).leases;
  }
  async captureReleaseIdentity(request: EnsureRequest): Promise<LeaseReleaseIdentity> {
    await this.resolve(request);
    const identity = await this.dependencies.git.identify(request.cwd);
    const lease = (await this.dependencies.store.read()).leases.find(
      (candidate) =>
        candidate.repositoryId === identity.repositoryId &&
        candidate.worktreeId === identity.worktreeId,
    );
    if (
      !lease ||
      lease.projectId !== request.config.project.id ||
      lease.configHash !== request.configHash
    ) {
      throw new MpxError({
        code: 'PORT_LEASE_MISMATCH',
        message: 'The lease no longer matches the authoritative registry.',
      });
    }
    return releaseIdentity(lease);
  }
  private async validateTombstone(
    file: string,
    identity: LeaseReleaseIdentity,
  ): Promise<'valid' | 'missing'> {
    const expectedPrefix = `${path.join(identity.worktreePath, '.worktree-ports.json')}.released-`;
    if (!path.normalize(file).startsWith(path.normalize(expectedPrefix))) {
      throw new MpxError({
        code: 'PORT_RELEASE_TOMBSTONE_INVALID',
        message: 'The projection tombstone is outside the captured worktree identity.',
      });
    }
    try {
      const status = await lstat(file);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error('not a regular file');
      }
      const projection = parseLeaseFile(
        parseStrictJson(await readFile(file, 'utf8')),
        'PORT_RELEASE_TOMBSTONE_INVALID',
      );
      if (
        projection.leaseId !== identity.leaseId ||
        projection.projectId !== identity.projectId ||
        projection.worktreeId !== identity.worktreeId ||
        projection.configHash !== identity.configHash
      ) {
        throw new Error('identity mismatch');
      }
      return 'valid';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'missing';
      }
      if (error instanceof MpxError && error.code === 'PORT_RELEASE_TOMBSTONE_INVALID') {
        throw error;
      }
      throw new MpxError({
        code: 'PORT_RELEASE_TOMBSTONE_INVALID',
        message: 'The projection tombstone is malformed, unsafe, or bound to another lease.',
        details: { cause: String(error) },
      });
    }
  }
  async releaseLinkedAfterRemoval(request: LinkedReleaseRequest): Promise<LinkedReleaseResult> {
    if (!validReleaseIdentity(request.identity)) {
      throw new MpxError({
        code: 'PORT_RELEASE_IDENTITY_MISMATCH',
        message: 'The captured release identity is malformed.',
      });
    }
    const current = await this.dependencies.git.identify(request.repositoryCwd);
    if (
      current.repositoryId !== request.identity.repositoryId ||
      (request.identity.commonGitPath !== undefined &&
        current.commonGitPath !== request.identity.commonGitPath)
    ) {
      throw new MpxError({
        code: 'PORT_RELEASE_REPOSITORY_MISMATCH',
        message: 'The surviving checkout does not belong to the captured repository.',
      });
    }
    const worktrees = await this.dependencies.git.list(request.repositoryCwd);
    if (
      worktrees.some(
        (candidate) =>
          candidate.prunable === undefined &&
          candidate.repositoryId === request.identity.repositoryId &&
          candidate.worktreeId === request.identity.worktreeId,
      )
    ) {
      throw new MpxError({
        code: 'PORT_WORKTREE_STILL_PRESENT',
        message: 'Git still reports the linked worktree; its lease cannot be released yet.',
      });
    }
    const tombstone =
      request.projectionTombstonePath === undefined
        ? undefined
        : await this.validateTombstone(request.projectionTombstonePath, request.identity);
    let released = false;
    await this.dependencies.store.transaction((state) => {
      const boundMain = state.leases.find(
        (candidate) =>
          candidate.role === 'main' &&
          candidate.repositoryId === request.identity.repositoryId &&
          candidate.projectId === request.identity.projectId &&
          candidate.configHash === request.identity.configHash,
      );
      if (!boundMain) {
        throw new MpxError({
          code: 'PORT_RELEASE_IDENTITY_MISMATCH',
          message: 'The captured release identity is not bound to the authoritative main lease.',
        });
      }
      const lease = state.leases.find(
        (candidate) => candidate.leaseId === request.identity.leaseId,
      );
      if (!lease) {
        return;
      }
      if (!sameReleaseIdentity(lease, request.identity)) {
        throw new MpxError({
          code: 'PORT_RELEASE_IDENTITY_MISMATCH',
          message: 'The captured release identity does not match the authoritative lease.',
        });
      }
      if (request.projectionTombstonePath !== undefined && tombstone === 'missing') {
        throw new MpxError({
          code: 'PORT_RELEASE_TOMBSTONE_INVALID',
          message: 'The projection tombstone is missing while the lease remains authoritative.',
        });
      }
      state.leases = state.leases.filter((candidate) => candidate !== lease);
      released = true;
    });
    if (request.projectionTombstonePath !== undefined && tombstone === 'valid') {
      await rm(request.projectionTombstonePath, { force: true });
    }
    return { released, identity: request.identity };
  }
  async resolveOrphan(request: LinkedReleaseRequest): Promise<LinkedReleaseResult> {
    return this.releaseLinkedAfterRemoval(request);
  }
  async release(request: { cwd: string }): Promise<void> {
    const identity = await this.dependencies.git.identify(request.cwd);
    const projectionPath = path.join(identity.path, '.worktree-ports.json');
    const tombstonePath = `${projectionPath}.released-${randomUUID()}`;
    let projectionMoved = false;
    try {
      await this.dependencies.store.transaction(async (state) => {
        const target = state.leases.find(
          (lease) =>
            lease.repositoryId === identity.repositoryId &&
            lease.worktreeId === identity.worktreeId,
        );
        if (
          target?.role === 'main' &&
          state.leases.some(
            (lease) => lease.repositoryId === identity.repositoryId && lease.role === 'linked',
          )
        ) {
          throw new MpxError({
            code: 'PORT_MAIN_HAS_LINKS',
            message: 'Release linked worktree leases before the main lease.',
          });
        }
        try {
          await rename(projectionPath, tombstonePath);
          projectionMoved = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        state.leases = state.leases.filter((lease) => lease !== target);
      });
    } catch (error) {
      if (projectionMoved) {
        await rename(tombstonePath, projectionPath).catch(() => undefined);
      }
      throw error;
    }
    if (projectionMoved) {
      await rm(tombstonePath, { force: true });
    }
  }
  async reconcile(request: {
    cwd: string;
    orphanPolicy?: 'release' | 'report';
  }): Promise<ReconcileResult> {
    const current = await this.dependencies.git.identify(request.cwd);
    const worktrees = (await this.dependencies.git.list(request.cwd)).filter(
      (worktree) => worktree.prunable === undefined,
    );
    const known = new Set(worktrees.map(({ worktreeId }) => worktreeId));
    const mainIdentity = worktrees.find(({ role }) => role === 'main');
    const removed: string[] = [];
    const repaired: LeaseRecord[] = [];
    const orphaned: LeaseReleaseIdentity[] = [];
    await this.dependencies.store.transaction(async (state) => {
      const staleMainIds = new Set(
        state.leases
          .filter(
            (lease) =>
              lease.repositoryId === current.repositoryId &&
              lease.role === 'main' &&
              mainIdentity &&
              lease.worktreeId !== mainIdentity.worktreeId,
          )
          .map(({ leaseId }) => leaseId),
      );
      const staleMainKeys = new Set(
        state.leases
          .filter(({ leaseId }) => staleMainIds.has(leaseId))
          .map((lease) => `${lease.repositoryId}\u0000${lease.projectId}\u0000${lease.configHash}`),
      );
      const retained: LeaseRecord[] = [];
      for (const lease of state.leases) {
        if (
          staleMainIds.has(lease.leaseId) ||
          (lease.role === 'linked' &&
            staleMainKeys.has(
              `${lease.repositoryId}\u0000${lease.projectId}\u0000${lease.configHash}`,
            ))
        ) {
          removed.push(lease.worktreeId);
        } else if (
          lease.repositoryId === current.repositoryId &&
          lease.role === 'linked' &&
          !known.has(lease.worktreeId)
        ) {
          let missing = false;
          try {
            await lstat(lease.worktreePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              missing = true;
              orphaned.push(releaseIdentity(lease));
            } else {
              throw new MpxError({
                code: 'PORT_RECONCILE_INSPECTION_FAILED',
                message: 'A linked worktree path could not be inspected during reconcile.',
                details: { worktreeId: lease.worktreeId, cause: String(error) },
              });
            }
          }
          if (missing && request.orphanPolicy !== 'report') {
            removed.push(lease.worktreeId);
          } else {
            retained.push(lease);
          }
        } else {
          retained.push(lease);
        }
      }
      state.leases = retained;
      repaired.push(
        ...state.leases.filter(
          (lease) => lease.repositoryId === current.repositoryId && known.has(lease.worktreeId),
        ),
      );
      state.lastReconciledAt = this.now();
    });
    const repairedIds: string[] = [];
    for (const lease of repaired) {
      let repairedNow = false;
      await this.dependencies.store.transaction(async (state) => {
        const authoritative = state.leases.find(({ leaseId }) => leaseId === lease.leaseId);
        if (!authoritative || !sameLease(authoritative, lease)) {
          return;
        }
        try {
          const status = await lstat(path.join(authoritative.worktreePath, '.worktree-ports.json'));
          if (status.isFile() && !status.isSymbolicLink()) {
            return;
          }
        } catch {
          /* repair */
        }
        await this.writeProjection(authoritative);
        repairedNow = true;
      });
      if (repairedNow) {
        repairedIds.push(lease.worktreeId);
      }
    }
    return { removed, repaired: repairedIds, orphaned };
  }
  async rebuild(request: RebuildRequest): Promise<RebuildResult> {
    try {
      return await this.dependencies.store.rebuildTransaction(async () =>
        this.buildRebuild(request.roots),
      );
    } catch (error) {
      if (
        error instanceof MpxError &&
        ['PORT_REBUILD_INVALID', 'PORT_REBUILD_LIMIT_EXCEEDED', 'PORT_LOCK_TIMEOUT'].includes(
          error.code,
        )
      ) {
        throw error;
      }
      throw new MpxError({
        code: 'PORT_REBUILD_INVALID',
        message: 'The rebuilt registry is globally inconsistent.',
        details: { cause: String(error) },
      });
    }
  }
  private async buildRebuild(
    roots: readonly string[],
  ): Promise<{ state: RegistryState; result: RebuildResult }> {
    let canonicalRoots: string[];
    let projectionPaths: string[];
    try {
      canonicalRoots = await this.canonicalizeRoots(roots);
      projectionPaths = await this.discoverProjections(canonicalRoots);
    } catch (error) {
      if (error instanceof MpxError) {
        throw error;
      }
      throw new MpxError({
        code: 'PORT_REBUILD_INVALID',
        message: 'Registry rebuild discovery failed.',
        details: { cause: String(error) },
      });
    }
    const candidates: RebuildCandidate[] = [];
    for (const projectionPath of projectionPaths) {
      try {
        const status = await lstat(projectionPath);
        if (!status.isFile() || status.isSymbolicLink()) {
          throw new Error('projection is not a regular file');
        }
        const projection = parseLeaseFile(
          parseStrictJson(await readFile(projectionPath, 'utf8')),
          'PORT_REBUILD_INVALID',
        );
        const worktreePath = await realpath(path.dirname(projectionPath));
        const found = await discoverProjectConfig(worktreePath);
        if (!found || path.normalize(await realpath(found.root)) !== path.normalize(worktreePath)) {
          throw new Error('worktree configuration not found');
        }
        const configHash = sha256Canonical(found.config as unknown as JsonValue);
        const identity = await this.dependencies.git.identify(worktreePath);
        const identityPath = await realpath(identity.path);
        if (
          path.normalize(identityPath) !== path.normalize(worktreePath) ||
          projection.projectId !== found.config.project.id ||
          projection.worktreeId !== identity.worktreeId ||
          projection.configHash !== configHash
        ) {
          throw new Error('projection identity or configuration does not match');
        }
        const defs = definitions(found.config);
        const expectedNames = defs.map(({ name }) => name).sort();
        if (
          Object.keys(projection.services).sort().join('\u0000') !== expectedNames.join('\u0000')
        ) {
          throw new Error('projection service set does not match');
        }
        candidates.push({
          projection,
          config: found.config,
          configHash,
          identity,
          definitions: defs,
        });
      } catch (error) {
        if (error instanceof MpxError && error.code === 'PORT_REBUILD_LIMIT_EXCEEDED') {
          throw error;
        }
        throw new MpxError({
          code: 'PORT_REBUILD_INVALID',
          message: 'A rebuild projection is malformed or inconsistent.',
          details: { path: projectionPath, cause: String(error) },
        });
      }
    }
    candidates.sort(
      (left, right) =>
        (left.identity.role === right.identity.role ? 0 : left.identity.role === 'main' ? -1 : 1) ||
        left.identity.repositoryId.localeCompare(right.identity.repositoryId) ||
        left.identity.worktreeId.localeCompare(right.identity.worktreeId),
    );
    const leases: LeaseRecord[] = [];
    for (const candidate of candidates) {
      try {
        const { identity, projection, definitions: defs } = candidate;
        const main = leases.find(
          (lease) =>
            lease.role === 'main' &&
            lease.repositoryId === identity.repositoryId &&
            lease.projectId === projection.projectId &&
            lease.configHash === projection.configHash,
        );
        if (identity.role === 'linked' && !main) {
          throw new Error('matching current main is absent');
        }
        if (identity.role === 'linked') {
          const currentMain = (await this.dependencies.git.list(identity.path)).find(
            ({ role }) => role === 'main',
          );
          if (!currentMain || currentMain.worktreeId !== main!.worktreeId) {
            throw new Error('rebuilt main is not the current Git main');
          }
        }
        const slots = new Set<number>();
        for (const family of buildPortFamilies(defs)) {
          for (const service of family.services) {
            const assigned = projection.services[service.name]!;
            const difference = assigned - service.preferred;
            if (difference < 0 || difference % family.width !== 0) {
              throw new Error('invalid checkout family arithmetic');
            }
            slots.add(difference / family.width);
          }
        }
        if (slots.size > 1) {
          throw new Error('checkout families imply different slots');
        }
        let slot = slots.values().next().value ?? 0;
        if (identity.role === 'linked' && slots.size === 0) {
          const usedSlots = new Set(
            leases
              .filter(
                (lease) => lease.repositoryId === identity.repositoryId && lease.role === 'linked',
              )
              .map(({ slot: usedSlot }) => usedSlot),
          );
          slot = 1;
          while (usedSlots.has(slot)) {
            slot += 1;
          }
        }
        if (identity.role === 'main' && slot !== 0) {
          throw new Error('main slot is not zero');
        }
        for (const definition of defs) {
          const assigned = projection.services[definition.name]!;
          if (definition.mode === 'fixed-shared' && assigned !== definition.preferred) {
            throw new Error('fixed service differs from preferred');
          }
          if (definition.mode === 'managed' && definition.scope === 'project') {
            const expected =
              identity.role === 'main' ? definition.preferred : main!.services[definition.name];
            if (assigned !== expected) {
              throw new Error('project-scoped service differs from main');
            }
          }
        }
        const managedPorts = defs
          .filter(({ mode }) => mode === 'managed')
          .map(({ name }) => projection.services[name]!);
        const fixedPorts = defs
          .filter(({ mode }) => mode === 'fixed-shared')
          .map(({ name }) => projection.services[name]!);
        if (
          new Set(managedPorts).size !== managedPorts.length ||
          fixedPorts.some((port) => managedPorts.includes(port))
        ) {
          throw new Error('service assignments collide');
        }
        const exclusive = defs
          .filter(
            ({ mode, scope }) =>
              mode === 'managed' && (scope === 'checkout' || identity.role === 'main'),
          )
          .map(({ name }) => projection.services[name]!);
        const shared = fixedPorts;
        leases.push({
          leaseId: projection.leaseId,
          projectId: projection.projectId,
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
          worktreePath: identity.path,
          role: identity.role,
          slot,
          configHash: candidate.configHash,
          services: Object.fromEntries(
            Object.entries(projection.services).sort(([a], [b]) => a.localeCompare(b)),
          ),
          claims: [
            ...[...new Set(exclusive)].map((port) => ({ port, exclusive: true })),
            ...[...new Set(shared)].map((port) => ({ port, exclusive: false })),
          ],
          updatedAt: this.now(),
          ...(identity.branch ? { branch: identity.branch } : {}),
          gitAdminPath: identity.gitAdminPath,
          commonGitPath: identity.commonGitPath,
        });
      } catch (error) {
        throw new MpxError({
          code: 'PORT_REBUILD_INVALID',
          message: 'A rebuild projection is malformed or inconsistent.',
          details: { path: candidate.identity.path, cause: String(error) },
        });
      }
    }
    return {
      state: { schemaVersion: 1, leases },
      result: {
        discovered: projectionPaths.length,
        rebuilt: leases.length,
        roots: canonicalRoots.length,
      },
    };
  }
  private async canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
    if (roots.length === 0) {
      throw new MpxError({
        code: 'PORT_REBUILD_INVALID',
        message: 'Registry rebuild requires at least one scan root.',
      });
    }
    const canonical = [...new Set(await Promise.all(roots.map((root) => realpath(root))))].sort(
      (a, b) => a.localeCompare(b),
    );
    return canonical.filter(
      (candidate) =>
        !canonical.some((parent) => {
          if (parent === candidate) {
            return false;
          }
          const relative = path.relative(parent, candidate);
          return (
            relative.length > 0 &&
            relative !== '..' &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
          );
        }),
    );
  }
  private async discoverProjections(canonicalRoots: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    let entries = 0;
    const maximumEntries = 100_000;
    const visit = async (directory: string): Promise<void> => {
      const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const child of children) {
        entries += 1;
        if (entries > maximumEntries) {
          throw new MpxError({
            code: 'PORT_REBUILD_LIMIT_EXCEEDED',
            message: 'Registry rebuild discovery exceeded its deterministic entry limit.',
          });
        }
        const childPath = path.join(directory, child.name);
        if (child.name === '.worktree-ports.json') {
          if (child.isSymbolicLink()) {
            throw new MpxError({
              code: 'PORT_REBUILD_INVALID',
              message: 'A rebuild projection must not be a symbolic link.',
              details: { path: childPath },
            });
          }
          found.push(childPath);
          continue;
        }
        if (
          child.isSymbolicLink() ||
          !child.isDirectory() ||
          ['.git', 'node_modules', '.pnpm', 'dist', '.mpx'].includes(child.name)
        ) {
          continue;
        }
        await visit(childPath);
      }
    };
    for (const root of canonicalRoots) {
      await visit(root);
    }
    return [...new Set(found.map((file) => path.normalize(file)))].sort((a, b) =>
      a.localeCompare(b),
    );
  }
  async inspect(): Promise<readonly import('./adapters.js').ListenerInfo[]> {
    return this.dependencies.platform.inspectListeners(
      (await this.list()).flatMap(({ claims }) => claims.map(({ port }) => port)),
    );
  }
  async kill(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid < 1) {
      throw new MpxError({
        code: 'PROCESS_ID_INVALID',
        message: 'A positive process ID is required.',
      });
    }
    const leases = await this.list();
    const registeredPorts = leases.flatMap(({ claims }) => claims.map(({ port }) => port));
    const listeners = (await this.dependencies.platform.inspectListeners(registeredPorts)).filter(
      (candidate) => candidate.pid === pid,
    );
    if (listeners.length === 0) {
      throw new MpxError({
        code: 'PROCESS_NOT_ON_MPX_PORT',
        message: 'The process is not listening on a registered MPX port.',
      });
    }
    const authorized = listeners.find((listener) =>
      leases.some((lease) =>
        lease.claims.some((claim) => claim.port === listener.port && claim.exclusive),
      ),
    );
    if (!authorized) {
      throw new MpxError({
        code: 'PROCESS_OWNERSHIP_UNVERIFIED',
        message:
          'The listener is not verified as belonging to the worktree that owns the exclusive port.',
      });
    }
    if (!authorized.startedAt) {
      throw new MpxError({
        code: 'PROCESS_FINGERPRINT_UNAVAILABLE',
        message: 'The process start fingerprint is unavailable.',
      });
    }
    await this.dependencies.platform.killProcess({ pid, startedAt: authorized.startedAt });
  }
  // fallow-ignore-next-line unused-class-member -- public operational diagnostics API.
  async diagnose(): Promise<{
    leases: number;
    conflicts: readonly import('./adapters.js').ListenerInfo[];
  }> {
    const leases = await this.list();
    return { leases: leases.length, conflicts: await this.inspect() };
  }
}
