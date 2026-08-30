import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import type { IdentityV1 } from './schemas.js';

export interface RootAttestationRecordV1 {
  readonly schemaVersion: 1;
  readonly ref: string;
  readonly identity: IdentityV1;
  readonly runtime: 'pi';
  readonly rootDigest: string;
  readonly mode: 'root-attested';
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface RootAttestationPlanV1 {
  readonly schemaVersion: 1;
  readonly operation: 'enroll' | 're-enroll';
  readonly identity: IdentityV1;
  readonly runtime: 'pi';
  readonly rootDigest: string;
  readonly mode: 'root-attested';
  readonly stateDigest: string;
  readonly confirmationDigest: string;
}
interface RegistryV1 {
  readonly schemaVersion: 1;
  readonly records: readonly RootAttestationRecordV1[];
}
interface ServiceOptions {
  readonly now?: () => string;
  readonly createRef?: () => string;
}
const digest = /^[a-f0-9]{64}$/u;
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const textPattern = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function fail(code: string, message: string): never {
  throw new MpxError({ code, message, retryable: false });
}
function parseIdentity(value: unknown): IdentityV1 {
  if (
    !exact(value, ['domain', 'name']) ||
    typeof value.domain !== 'string' ||
    typeof value.name !== 'string' ||
    !textPattern.test(value.domain) ||
    !textPattern.test(value.name) ||
    value.domain !== value.domain.normalize('NFC') ||
    value.name !== value.name.normalize('NFC')
  ) {
    fail('ACCOUNT_REGISTRY_MALFORMED', 'The account attestation registry is malformed.');
  }
  return Object.freeze({ domain: value.domain, name: value.name });
}
function parseRecord(value: unknown): RootAttestationRecordV1 {
  if (
    !exact(value, [
      'schemaVersion',
      'ref',
      'identity',
      'runtime',
      'rootDigest',
      'mode',
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.runtime !== 'pi' ||
    value.mode !== 'root-attested' ||
    typeof value.ref !== 'string' ||
    !refPattern.test(value.ref) ||
    typeof value.rootDigest !== 'string' ||
    !digest.test(value.rootDigest) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !timestampPattern.test(value.createdAt) ||
    !timestampPattern.test(value.updatedAt)
  ) {
    fail('ACCOUNT_REGISTRY_MALFORMED', 'The account attestation registry is malformed.');
  }
  const identity = parseIdentity(value.identity);
  try {
    if (
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      new Date(value.updatedAt).toISOString() !== value.updatedAt
    ) {
      throw new Error();
    }
  } catch {
    fail('ACCOUNT_REGISTRY_MALFORMED', 'The account attestation registry is malformed.');
  }
  return Object.freeze({
    schemaVersion: 1,
    ref: value.ref,
    identity,
    runtime: 'pi',
    rootDigest: value.rootDigest,
    mode: 'root-attested',
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
function parseRegistry(value: unknown): RegistryV1 {
  if (
    !exact(value, ['schemaVersion', 'records']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length > 1024
  ) {
    fail('ACCOUNT_REGISTRY_MALFORMED', 'The account attestation registry is malformed.');
  }
  const records = value.records.map(parseRecord);
  const identities = new Set<string>(),
    roots = new Set<string>(),
    refs = new Set<string>();
  for (const record of records) {
    const key = JSON.stringify(record.identity);
    if (identities.has(key) || roots.has(record.rootDigest) || refs.has(record.ref)) {
      fail(
        'ACCOUNT_REGISTRY_MALFORMED',
        'The account attestation registry contains duplicate claims.',
      );
    }
    identities.add(key);
    roots.add(record.rootDigest);
    refs.add(record.ref);
  }
  return Object.freeze({ schemaVersion: 1, records: Object.freeze(records) });
}
function registryDigest(registry: RegistryV1): string {
  return sha256Canonical(registry as unknown as JsonValue);
}
function sameIdentity(left: IdentityV1, right: IdentityV1): boolean {
  return left.domain === right.domain && left.name === right.name;
}
const normalizedPath = (value: string): string =>
  process.platform === 'win32'
    ? path.normalize(value).replaceAll('\\', '/').toLowerCase()
    : path.normalize(value);
function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isDirectory() === right.isDirectory() &&
    left.isFile() === right.isFile() &&
    (typeof left.ino !== 'number' ||
      typeof right.ino !== 'number' ||
      left.ino === 0 ||
      right.ino === 0 ||
      (left.ino === right.ino && left.dev === right.dev))
  );
}
async function canonicalRootDigest(root: string): Promise<string> {
  try {
    if (!path.isAbsolute(root)) {
      throw new Error();
    }
    const before = await lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error();
    }
    const canonical = await realpath(root);
    const [after, canonicalInfo, canonicalAgain] = await Promise.all([
      lstat(root),
      lstat(canonical),
      realpath(root),
    ]);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      canonicalInfo.isSymbolicLink() ||
      !canonicalInfo.isDirectory() ||
      !sameFile(before, after) ||
      !sameFile(after, canonicalInfo) ||
      normalizedPath(canonicalAgain) !== normalizedPath(canonical) ||
      normalizedPath(canonical) !== normalizedPath(path.resolve(root))
    ) {
      throw new Error();
    }
    return sha256Canonical(normalizedPath(canonical) as unknown as JsonValue);
  } catch {
    return fail('ACCOUNT_ROOT_INVALID', 'The configured Pi identity root is missing or unsafe.');
  }
}
type PidLiveness = (pid: number) => boolean | undefined | Promise<boolean | undefined>;
interface StoreOptions {
  readonly lockWaitMs?: number;
  readonly staleInitializationMs?: number;
  readonly now?: () => number;
  readonly isPidAlive?: PidLiveness;
  readonly processId?: number;
  readonly afterLockInitializerCreated?: (lock: string, token: string) => Promise<void>;
  readonly afterLockOwnerCreated?: (lock: string, token: string) => Promise<void>;
  readonly readLockFile?: (file: string) => Promise<string>;
  readonly renameLock?: (source: string, target: string) => Promise<void>;
  readonly releaseWait?: (milliseconds: number) => Promise<void>;
}
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
function defaultPidLiveness(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined;
  }
}
export class RootAttestationStore {
  readonly registryFile: string;
  readonly #lockWaitMs: number;
  readonly #staleInitializationMs: number;
  readonly #now: () => number;
  readonly #isPidAlive: PidLiveness;
  readonly #processId: number;
  readonly #afterLockInitializerCreated:
    ((lock: string, token: string) => Promise<void>) | undefined;
  readonly #afterLockOwnerCreated: ((lock: string, token: string) => Promise<void>) | undefined;
  readonly #readLockFile: (file: string) => Promise<string>;
  readonly #renameLock: (source: string, target: string) => Promise<void>;
  readonly #releaseWait: (milliseconds: number) => Promise<void>;
  constructor(
    readonly stateRoot: string,
    options: StoreOptions = {},
  ) {
    this.registryFile = path.join(stateRoot, 'accounts', 'v1', 'registry.json');
    this.#lockWaitMs = options.lockWaitMs ?? 5_000;
    this.#staleInitializationMs = options.staleInitializationMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#isPidAlive = options.isPidAlive ?? defaultPidLiveness;
    this.#processId = options.processId ?? process.pid;
    this.#afterLockInitializerCreated = options.afterLockInitializerCreated;
    this.#afterLockOwnerCreated = options.afterLockOwnerCreated;
    this.#readLockFile = options.readLockFile ?? ((file) => readFile(file, 'utf8'));
    this.#renameLock = options.renameLock ?? rename;
    this.#releaseWait = options.releaseWait ?? wait;
  }
  async #safeParent(create = true): Promise<void> {
    const parent = path.dirname(this.registryFile);
    if (create) {
      await mkdir(parent, { recursive: true });
    }
    for (const directory of [this.stateRoot, path.join(this.stateRoot, 'accounts'), parent]) {
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(directory);
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }
      const canonical = await realpath(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        normalizedPath(canonical) !== normalizedPath(path.resolve(directory))
      ) {
        fail('ACCOUNT_REGISTRY_MALFORMED', 'The account attestation registry parent is unsafe.');
      }
    }
  }
  async #read(): Promise<RegistryV1> {
    try {
      await this.#safeParent(false);
      const info = await lstat(this.registryFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
        return fail('ACCOUNT_REGISTRY_MALFORMED', 'The account attestation registry is unsafe.');
      }
      return parseRegistry(JSON.parse(await readFile(this.registryFile, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, records: [] };
      }
      if (error instanceof MpxError) {
        throw error;
      }
      return fail('ACCOUNT_REGISTRY_MALFORMED', 'The account attestation registry is malformed.');
    }
  }
  async list(): Promise<readonly RootAttestationRecordV1[]> {
    return (await this.#read()).records;
  }
  async snapshot(): Promise<{ registry: RegistryV1; digest: string }> {
    const registry = await this.#read();
    return { registry, digest: registryDigest(registry) };
  }
  async #atomic(registry: RegistryV1): Promise<void> {
    await this.#safeParent();
    const existing = await lstat(this.registryFile).catch(() => undefined);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      fail('ACCOUNT_REGISTRY_MALFORMED', 'The account attestation registry is unsafe.');
    }
    const temporary = `${this.registryFile}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.registryFile);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  async #owner(
    lock: string,
  ): Promise<{ kind: 'absent' | 'malformed' } | { kind: 'present'; pid: number; token: string }> {
    let raw: string;
    try {
      raw = await this.#readLockFile(path.join(lock, 'owner.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'absent' };
      }
      throw error;
    }
    try {
      const value = JSON.parse(raw) as { pid?: unknown; token?: unknown };
      return Number.isSafeInteger(value.pid) &&
        (value.pid as number) > 0 &&
        typeof value.token === 'string' &&
        value.token.length > 0
        ? { kind: 'present', pid: value.pid as number, token: value.token }
        : { kind: 'malformed' };
    } catch {
      return { kind: 'malformed' };
    }
  }
  async #reclaim(lock: string): Promise<boolean> {
    const owner = await this.#owner(lock);
    if (owner.kind === 'present') {
      if ((await this.#isPidAlive(owner.pid)) !== false) {
        return false;
      }
      const proof = await this.#owner(lock);
      if (
        proof.kind !== 'present' ||
        proof.pid !== owner.pid ||
        proof.token !== owner.token ||
        (await this.#isPidAlive(owner.pid)) !== false
      ) {
        return false;
      }
      const tombstone = `${lock}.dead-${owner.token}-${randomUUID()}`;
      try {
        await rename(lock, tombstone);
      } catch {
        return false;
      }
      await rm(tombstone, { recursive: true, force: true });
      return true;
    }
    let info;
    try {
      info =
        owner.kind === 'malformed' ? await lstat(path.join(lock, 'owner.json')) : await lstat(lock);
    } catch {
      return false;
    }
    let names: string[];
    try {
      names = await readdir(lock);
    } catch {
      return false;
    }
    const initializers = names.filter((name) => /^initializer-[0-9a-f-]+\.json$/u.test(name));
    if (initializers.length > 1) {
      return false;
    }
    let definitelyDeadInitializer = false;
    if (initializers.length === 1) {
      const markerFile = path.join(lock, initializers[0]!);
      let markerInfo: Awaited<ReturnType<typeof lstat>>;
      try {
        markerInfo = await lstat(markerFile);
      } catch {
        return false;
      }
      info = markerInfo;
      let marker: { pid?: unknown; token?: unknown } | undefined;
      try {
        marker = JSON.parse(await readFile(markerFile, 'utf8')) as {
          pid?: unknown;
          token?: unknown;
        };
      } catch (error) {
        if (error instanceof SyntaxError) {
          marker = undefined;
        } else {
          return false;
        }
      }
      if (
        marker &&
        Number.isSafeInteger(marker.pid) &&
        (marker.pid as number) > 0 &&
        typeof marker.token === 'string' &&
        initializers[0] === `initializer-${marker.token}.json`
      ) {
        const alive = await this.#isPidAlive(marker.pid as number);
        if (alive !== false) {
          return false;
        }
        definitelyDeadInitializer = true;
      } else if (this.#now() - markerInfo.mtimeMs <= this.#staleInitializationMs) {
        return false;
      }
    }
    if (!definitelyDeadInitializer && this.#now() - info.mtimeMs <= this.#staleInitializationMs) {
      return false;
    }
    const tombstone = `${lock}.orphan-${randomUUID()}`;
    try {
      await rename(lock, tombstone);
    } catch {
      return false;
    }
    await rm(tombstone, { recursive: true, force: true });
    return true;
  }
  async #stillOwns(lock: string, token: string, deadline: number): Promise<boolean> {
    while (true) {
      try {
        const owner = await this.#owner(lock);
        return owner.kind === 'present' && owner.pid === this.#processId && owner.token === token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM' || Date.now() >= deadline) {
          throw error;
        }
        await this.#releaseWait(25);
      }
    }
  }
  async #release(lock: string, token: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    if (!(await this.#stillOwns(lock, token, deadline))) {
      return;
    }
    const tombstone = `${lock}.released-${token}`;
    while (true) {
      try {
        await this.#renameLock(lock, tombstone);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EEXIST') {
          return;
        }
        if (code !== 'EPERM' || Date.now() >= deadline) {
          throw error;
        }
        if (!(await this.#stillOwns(lock, token, deadline))) {
          return;
        }
        await this.#releaseWait(25);
      }
    }
    await rm(tombstone, { recursive: true, force: true });
  }
  async transaction<T>(
    action: (
      registry: RegistryV1,
    ) => Promise<{ registry: RegistryV1; result: T }> | { registry: RegistryV1; result: T },
  ): Promise<T> {
    await this.#safeParent();
    const lock = `${this.registryFile}.lock`,
      deadline = this.#now() + this.#lockWaitMs,
      token = randomUUID();
    while (true) {
      try {
        await mkdir(lock);
        let ownerCreated = false;
        try {
          const initializer = path.join(lock, `initializer-${token}.json`);
          const handle = await open(initializer, 'wx', 0o600);
          await handle.writeFile(JSON.stringify({ pid: this.#processId, token }));
          await handle.close();
          await this.#afterLockInitializerCreated?.(lock, token);
          let marker: { pid?: unknown; token?: unknown };
          try {
            marker = JSON.parse(await readFile(initializer, 'utf8')) as {
              pid?: unknown;
              token?: unknown;
            };
          } catch {
            fail(
              'ACCOUNT_REGISTRY_LOCK_OWNERSHIP_LOST',
              'Account registry lock initialization was superseded.',
            );
          }
          if (marker.pid !== this.#processId || marker.token !== token) {
            fail(
              'ACCOUNT_REGISTRY_LOCK_OWNERSHIP_LOST',
              'Account registry lock initialization was superseded.',
            );
          }
          await open(path.join(lock, 'owner.json'), 'wx', 0o600).then(async (owner) => {
            try {
              await owner.writeFile(JSON.stringify({ pid: this.#processId, token }));
            } finally {
              await owner.close();
            }
          });
          ownerCreated = true;
          await this.#afterLockOwnerCreated?.(lock, token);
          await rm(initializer);
        } catch (error) {
          if (ownerCreated) {
            await this.#release(lock, token).catch(() => undefined);
          } else {
            const initializer = path.join(lock, `initializer-${token}.json`),
              claim = path.join(lock, `.initializer-failed-${token}`);
            try {
              await rename(initializer, claim);
              const tombstone = `${lock}.failed-${token}`;
              await rename(lock, tombstone);
              await rm(tombstone, { recursive: true, force: true });
            } catch {
              /* A superseding owner now controls this path. */
            }
          }
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        if (await this.#reclaim(lock)) {
          continue;
        }
        if (this.#now() >= deadline) {
          fail('ACCOUNT_REGISTRY_LOCK_TIMEOUT', 'Timed out waiting for the account registry lock.');
        }
        await wait(10);
      }
    }
    try {
      const changed = await action(await this.#read());
      const valid = parseRegistry(changed.registry);
      await this.#atomic(valid);
      return changed.result;
    } finally {
      await this.#release(lock, token);
    }
  }
}
export class RootAttestationService {
  readonly #now: () => string;
  readonly #createRef: () => string;
  constructor(
    readonly store: RootAttestationStore,
    options: ServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createRef = options.createRef ?? (() => `pi-${randomUUID()}`);
  }
  async plan(
    operation: 'enroll' | 're-enroll',
    identityInput: IdentityV1,
    root: string,
  ): Promise<RootAttestationPlanV1> {
    const identity = parseIdentity(identityInput),
      rootDigest = await canonicalRootDigest(root),
      { registry, digest: stateDigest } = await this.store.snapshot();
    const existing = registry.records.find((record) => sameIdentity(record.identity, identity));
    const conflict = registry.records.find(
      (record) => record.rootDigest === rootDigest && !sameIdentity(record.identity, identity),
    );
    if (conflict) {
      fail(
        'ACCOUNT_ROOT_DUPLICATE',
        'The configured Pi root is already attested to another identity.',
      );
    }
    if (operation === 'enroll' && existing) {
      fail('ACCOUNT_IDENTITY_DUPLICATE', 'The Pi identity is already enrolled; use re-enroll.');
    }
    if (operation === 're-enroll' && !existing) {
      fail('ACCOUNT_ENROLLMENT_MISSING', 'The Pi identity is not enrolled.');
    }
    const tuple = {
      schemaVersion: 1 as const,
      operation,
      identity,
      runtime: 'pi' as const,
      rootDigest,
      mode: 'root-attested' as const,
      stateDigest,
    };
    return Object.freeze({
      ...tuple,
      confirmationDigest: sha256Canonical(tuple as unknown as JsonValue),
    });
  }
  async confirm(plan: RootAttestationPlanV1): Promise<RootAttestationRecordV1> {
    const expected = {
      schemaVersion: 1 as const,
      operation: plan.operation,
      identity: parseIdentity(plan.identity),
      runtime: 'pi' as const,
      rootDigest: plan.rootDigest,
      mode: 'root-attested' as const,
      stateDigest: plan.stateDigest,
    };
    if (
      plan.schemaVersion !== 1 ||
      plan.runtime !== 'pi' ||
      plan.mode !== 'root-attested' ||
      (plan.operation !== 'enroll' && plan.operation !== 're-enroll') ||
      !digest.test(plan.rootDigest) ||
      !digest.test(plan.stateDigest) ||
      plan.confirmationDigest !== sha256Canonical(expected as unknown as JsonValue)
    ) {
      fail('ACCOUNT_PLAN_INVALID', 'The account enrollment plan is invalid.');
    }
    return this.store.transaction((registry) => {
      if (registryDigest(registry) !== plan.stateDigest) {
        fail('ACCOUNT_PLAN_STALE', 'The account enrollment plan is stale.');
      }
      const existing = registry.records.find((record) =>
        sameIdentity(record.identity, plan.identity),
      );
      if (
        registry.records.some(
          (record) =>
            record.rootDigest === plan.rootDigest && !sameIdentity(record.identity, plan.identity),
        )
      ) {
        fail(
          'ACCOUNT_ROOT_DUPLICATE',
          'The configured Pi root is already attested to another identity.',
        );
      }
      if (plan.operation === 'enroll' && existing) {
        fail('ACCOUNT_IDENTITY_DUPLICATE', 'The Pi identity is already enrolled; use re-enroll.');
      }
      if (plan.operation === 're-enroll' && !existing) {
        fail('ACCOUNT_ENROLLMENT_MISSING', 'The Pi identity is not enrolled.');
      }
      const timestamp = this.#now();
      const record = parseRecord({
        schemaVersion: 1,
        ref: existing?.ref ?? this.#createRef(),
        identity: plan.identity,
        runtime: 'pi',
        rootDigest: plan.rootDigest,
        mode: 'root-attested',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      return {
        registry: {
          schemaVersion: 1,
          records: [
            ...registry.records.filter((item) => !sameIdentity(item.identity, plan.identity)),
            record,
          ],
        },
        result: record,
      };
    });
  }
  async find(identity: IdentityV1): Promise<RootAttestationRecordV1 | undefined> {
    return (await this.store.list()).find((record) => sameIdentity(record.identity, identity));
  }
  async verify(identity: IdentityV1, root: string, ref?: string): Promise<RootAttestationRecordV1> {
    const record = await this.find(identity);
    if (!record) {
      return fail('ACCOUNT_ENROLLMENT_MISSING', 'The Pi identity is not enrolled.');
    }
    if (ref !== undefined && record.ref !== ref) {
      return fail(
        'ACCOUNT_BINDING_MISMATCH',
        'The Pi account binding reference does not match enrollment.',
      );
    }
    if (record.rootDigest !== (await canonicalRootDigest(root))) {
      return fail(
        'ACCOUNT_ROOT_CHANGED',
        'The configured Pi identity root changed after enrollment.',
      );
    }
    return record;
  }
}
