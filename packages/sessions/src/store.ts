import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeName } from '@mpx/runtime-contracts';
import {
  SessionError,
  parseLegacyImportJournalV1,
  parseLegacyImportReceiptV1,
  parseLifecycleBindingRecordV1,
  parseNativeBindingRecordV1,
  parseSessionCaptureV1,
  parseSessionRecordV1,
  parseSessionRegistryV1,
  type IdentityV1,
  type LegacyImportJournalV1,
  type LegacyImportReceiptV1,
  type NativeBindingRecordV1,
  type SessionCaptureV1,
  type SessionLifecycleBindingRecordV1,
  type SessionRecordV1,
  type SessionRegistryV1,
} from './schemas.js';

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const decode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

interface ReleaseLockBoundary {
  readonly readOwner: (file: string) => Promise<unknown>;
  readonly rename: (source: string, target: string) => Promise<void>;
  readonly wait: (milliseconds: number) => Promise<void>;
}
export interface StoreOptions {
  readonly lockWaitMs?: number;
  readonly staleLockMs?: number;
  readonly now?: () => number;
  readonly afterLockInitializerCreated?: (lock: string, token: string) => Promise<void>;
  readonly isPidAlive?: (pid: number) => boolean | undefined | Promise<boolean | undefined>;
  readonly processId?: number;
  readonly releaseLock?: ReleaseLockBoundary;
}
export class SessionStore {
  private readonly lockWaitMs: number;
  private readonly staleLockMs: number;
  private readonly now: () => number;
  private readonly afterLockInitializerCreated:
    ((lock: string, token: string) => Promise<void>) | undefined;
  private readonly isPidAlive: (pid: number) => boolean | undefined | Promise<boolean | undefined>;
  private readonly processId: number;
  private readonly releaseReadOwner: (file: string) => Promise<unknown>;
  private readonly releaseRename: (source: string, target: string) => Promise<void>;
  private readonly releaseWait: (milliseconds: number) => Promise<void>;
  constructor(
    readonly stateRoot: string,
    options: StoreOptions = {},
  ) {
    this.lockWaitMs = options.lockWaitMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.afterLockInitializerCreated = options.afterLockInitializerCreated;
    this.isPidAlive =
      options.isPidAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined;
        }
      });
    this.processId = options.processId ?? process.pid;
    this.releaseReadOwner =
      options.releaseLock?.readOwner ?? ((file) => this.readJson(file, 16_384));
    this.releaseRename = options.releaseLock?.rename ?? rename;
    this.releaseWait = options.releaseLock?.wait ?? wait;
  }

  partitionDirectory(identity: IdentityV1, runtime: RuntimeName): string {
    return path.join(
      this.stateRoot,
      'sessions',
      'v1',
      'identities',
      `d-${encode(identity.domain)}`,
      `n-${encode(identity.name)}`,
      runtime,
    );
  }
  registryPath(identity: IdentityV1, runtime: RuntimeName): string {
    return path.join(this.partitionDirectory(identity, runtime), 'registry.json');
  }
  capturePath(identity: IdentityV1, runtime: RuntimeName, captureId: string): string {
    return path.join(
      this.partitionDirectory(identity, runtime),
      'captures',
      `${encode(captureId)}.json`,
    );
  }
  nativeBindingPath(ref: string): string {
    return path.join(
      this.stateRoot,
      'sessions',
      'v1',
      'private',
      'native-bindings',
      `${encode(ref)}.json`,
    );
  }
  lifecycleBindingPath(bindingId: string): string {
    return path.join(
      this.stateRoot,
      'sessions',
      'v1',
      'private',
      'lifecycle-bindings',
      `${encode(bindingId)}.json`,
    );
  }
  eventDirectory(bindingId: string): string {
    return path.join(
      this.stateRoot,
      'sessions',
      'v1',
      'private',
      'lifecycle-events',
      encode(bindingId),
    );
  }
  async validateEventDirectory(bindingId: string): Promise<boolean> {
    const expected = path.resolve(this.eventDirectory(bindingId));
    let linked;
    try {
      linked = await lstat(expected);
    } catch (error) {
      if (missing(error)) {
        return false;
      }
      throw error;
    }
    const [resolvedRoot, resolvedDirectory] = await Promise.all([
      realpath(this.stateRoot),
      realpath(expected),
    ]);
    const relative = path.relative(resolvedRoot, resolvedDirectory);
    if (
      linked.isSymbolicLink() ||
      !linked.isDirectory() ||
      path.relative(expected, resolvedDirectory) !== '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new SessionError(
        'SESSION_UNSAFE_EVENT_DIRECTORY',
        'lifecycle event directory must remain the expected real non-symlink directory under the session store',
      );
    }
    return true;
  }
  journalPath(digest: string): string {
    return path.join(
      this.stateRoot,
      'sessions',
      'v1',
      'private',
      'imports',
      `${digest}.journal.json`,
    );
  }
  receiptPath(digest: string): string {
    return path.join(this.stateRoot, 'sessions', 'v1', 'private', 'imports', `${digest}.json`);
  }

  private async assertRegular(file: string): Promise<void> {
    const linked = await lstat(file);
    if (linked.isSymbolicLink() || !linked.isFile()) {
      throw new SessionError(
        'SESSION_UNSAFE_FILE',
        'session state must be a regular non-symlink file',
      );
    }
  }
  private async readJson(file: string, maximumBytes = 8 * 1024 * 1024): Promise<unknown> {
    await this.assertRegular(file);
    const info = await stat(file);
    if (info.size > maximumBytes) {
      throw new SessionError('SESSION_FILE_TOO_LARGE', 'session state exceeds its size bound');
    }
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  }
  private async atomicJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const existing = await lstat(file).catch(() => undefined);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new SessionError('SESSION_UNSAFE_FILE', 'refusing to replace unsafe session state');
    }
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    const directory = await open(path.dirname(file), 'r').catch(() => undefined);
    if (directory) {
      try {
        await directory.sync();
      } catch {
        /* Windows does not fsync directory handles. */
      } finally {
        await directory.close();
      }
    }
  }
  private initializer(lock: string, token: string): string {
    return path.join(lock, `initializer-${token}.json`);
  }
  private async ownsInitializer(lock: string, token: string): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(this.initializer(lock, token), 'utf8')) as unknown;
      return Boolean(
        value && typeof value === 'object' && (value as { token?: unknown }).token === token,
      );
    } catch {
      return false;
    }
  }
  private async removeInitializingLock(lock: string, token: string): Promise<void> {
    const marker = this.initializer(lock, token),
      claim = path.join(lock, `.initializer-claimed-${token}`);
    try {
      await rename(marker, claim);
    } catch {
      return;
    }
    const tombstone = `${lock}.initialization-failed-${token}`;
    try {
      await rename(lock, tombstone);
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
      return;
    }
    await rm(tombstone, { recursive: true, force: true });
  }
  private async removeOrphanedInitialization(lock: string): Promise<boolean> {
    let names: string[],
      ageSource = lock;
    try {
      names = await readdir(lock);
    } catch {
      return false;
    }
    const markers = names.filter((name) => /^initializer-[0-9a-f-]+\.json$/u.test(name));
    if (markers.length > 1) {
      return false;
    }
    if (markers.length === 1) {
      ageSource = path.join(lock, markers[0]!);
    }
    let info;
    try {
      info = await stat(ageSource);
    } catch {
      return false;
    }
    if (markers.length === 1) {
      try {
        const marker = JSON.parse(await readFile(ageSource, 'utf8')) as {
          pid?: unknown;
          token?: unknown;
        };
        if (
          Number.isSafeInteger(marker.pid) &&
          (marker.pid as number) > 0 &&
          typeof marker.token === 'string' &&
          markers[0] === `initializer-${marker.token}.json`
        ) {
          if ((await this.isPidAlive(marker.pid as number)) !== false) {
            return false;
          }
        } else if (this.now() - info.mtimeMs <= this.staleLockMs) {
          return false;
        }
      } catch {
        if (this.now() - info.mtimeMs <= this.staleLockMs) {
          return false;
        }
      }
    } else if (this.now() - info.mtimeMs <= this.staleLockMs) {
      return false;
    }
    const claim = path.join(lock, '.orphan-initialization-claim');
    try {
      if (markers.length === 1) {
        await rename(ageSource, claim);
      } else {
        await writeFile(claim, '', { flag: 'wx', mode: 0o600 });
      }
    } catch {
      return false;
    }
    const tombstone = `${lock}.orphan-${randomUUID()}`;
    try {
      await rename(lock, tombstone);
    } catch (error) {
      if (missing(error)) {
        return false;
      }
      throw error;
    }
    await rm(tombstone, { recursive: true, force: true });
    return true;
  }
  private async stillOwns(lock: string, ownerToken: string, deadline: number): Promise<boolean> {
    while (true) {
      try {
        const owner = await this.releaseReadOwner(path.join(lock, 'owner.json'));
        return Boolean(
          owner &&
          typeof owner === 'object' &&
          (owner as { ownerToken?: unknown }).ownerToken === ownerToken,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        if ((error as NodeJS.ErrnoException).code !== 'EPERM' || Date.now() >= deadline) {
          throw error;
        }
        await this.releaseWait(25);
      }
    }
  }
  private async removeOwnedLock(lock: string, ownerToken: string): Promise<void> {
    const releaseDeadline = Date.now() + 2_000;
    if (!(await this.stillOwns(lock, ownerToken, releaseDeadline))) {
      return;
    }
    const tombstone = `${lock}.released-${ownerToken}`;
    while (true) {
      try {
        await this.releaseRename(lock, tombstone);
        break;
      } catch (error) {
        if (missing(error) || (error as NodeJS.ErrnoException).code === 'EEXIST') {
          return;
        }
        if ((error as NodeJS.ErrnoException).code !== 'EPERM' || Date.now() >= releaseDeadline) {
          throw error;
        }
        if (!(await this.stillOwns(lock, ownerToken, releaseDeadline))) {
          return;
        }
        await this.releaseWait(25);
      }
    }
    await rm(tombstone, { recursive: true, force: true });
  }
  private async removeStaleLock(
    lock: string,
    ownerToken: string,
    ownerPid: number,
  ): Promise<boolean> {
    if ((await this.isPidAlive(ownerPid)) !== false) {
      return false;
    }
    try {
      const owner = await this.readJson(path.join(lock, 'owner.json'), 16_384);
      if (
        !owner ||
        typeof owner !== 'object' ||
        (owner as { ownerToken?: unknown; pid?: unknown }).ownerToken !== ownerToken ||
        (owner as { pid?: unknown }).pid !== ownerPid ||
        (await this.isPidAlive(ownerPid)) !== false
      ) {
        return false;
      }
      const tombstone = `${lock}.dead-${ownerToken}-${randomUUID()}`;
      await rename(lock, tombstone);
      await rm(tombstone, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (missing(error)) {
        return false;
      }
      throw error;
    }
  }
  private async withLock<T>(file: string, action: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`,
      deadline = this.now() + this.lockWaitMs,
      ownerToken = randomUUID();
    while (true) {
      try {
        await mkdir(lock);
        try {
          const marker = this.initializer(lock, ownerToken);
          await writeFile(marker, JSON.stringify({ pid: this.processId, token: ownerToken }), {
            flag: 'wx',
            mode: 0o600,
          });
          await this.afterLockInitializerCreated?.(lock, ownerToken);
          if (!(await this.ownsInitializer(lock, ownerToken))) {
            throw new SessionError(
              'SESSION_LOCK_OWNERSHIP_LOST',
              'session lock initialization was superseded',
            );
          }
          const acquiredAt = this.now();
          await writeFile(
            path.join(lock, 'owner.json'),
            JSON.stringify({ pid: this.processId, ownerToken, acquiredAt }),
            { flag: 'wx', mode: 0o600 },
          );
          const lease = path.join(lock, `lease-${ownerToken}`);
          await writeFile(lease, '', { flag: 'wx', mode: 0o600 });
          await utimes(lease, acquiredAt / 1000, acquiredAt / 1000);
          await rm(marker);
        } catch (error) {
          await this.removeInitializingLock(lock, ownerToken);
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const owner = (await this.readJson(path.join(lock, 'owner.json'), 16_384).catch(
          () => undefined,
        )) as { ownerToken?: unknown; pid?: unknown } | undefined;
        if (
          owner &&
          typeof owner.ownerToken === 'string' &&
          Number.isSafeInteger(owner.pid) &&
          (owner.pid as number) > 0 &&
          (await this.removeStaleLock(lock, owner.ownerToken, owner.pid as number))
        ) {
          continue;
        }
        if (
          (!owner || typeof owner.ownerToken !== 'string') &&
          (await this.removeOrphanedInitialization(lock))
        ) {
          continue;
        }
        if (this.now() >= deadline) {
          throw new SessionError(
            'SESSION_LOCK_TIMEOUT',
            'timed out waiting for session transaction lock',
          );
        }
        await wait(10);
      }
    }
    let heartbeatFailure: unknown;
    const lease = path.join(lock, `lease-${ownerToken}`);
    const heartbeat = setInterval(
      () => {
        const timestamp = this.now() / 1000;
        // utimes is successor-safe: unlike a write, it cannot recreate a lease after takeover.
        void utimes(lease, timestamp, timestamp).catch((error) => {
          heartbeatFailure = error;
        });
      },
      Math.max(10, Math.floor(this.staleLockMs / 3)),
    );
    try {
      const result = await action();
      if (heartbeatFailure) {
        throw heartbeatFailure;
      }
      return result;
    } finally {
      clearInterval(heartbeat);
      await this.removeOwnedLock(lock, ownerToken);
    }
  }

  async read(identity: IdentityV1, runtime: RuntimeName): Promise<SessionRegistryV1> {
    const file = this.registryPath(identity, runtime);
    try {
      return parseSessionRegistryV1(await this.readJson(file));
    } catch (error) {
      if (missing(error)) {
        return {
          schemaVersion: 1,
          identity,
          runtime,
          records: [],
          recentEventIds: [],
        };
      }
      if (error instanceof SessionError) {
        throw error;
      }
      throw new SessionError('SESSION_REGISTRY_CORRUPT', `session registry is corrupt: ${file}`);
    }
  }
  async transaction<T>(
    identity: IdentityV1,
    runtime: RuntimeName,
    mutate: (
      registry: SessionRegistryV1,
    ) =>
      | Promise<{ registry: SessionRegistryV1; result: T }>
      | { registry: SessionRegistryV1; result: T },
  ): Promise<T> {
    const file = this.registryPath(identity, runtime);
    return this.withLock(file, async () => {
      const current = await this.read(identity, runtime);
      const changed = await mutate(current);
      const valid = parseSessionRegistryV1(changed.registry);
      if (
        valid.identity.domain !== identity.domain ||
        valid.identity.name !== identity.name ||
        valid.runtime !== runtime
      ) {
        throw new SessionError('SESSION_PARTITION_MISMATCH', 'transaction changed its partition');
      }
      await this.atomicJson(file, valid);
      return changed.result;
    });
  }
  async put(record: SessionRecordV1): Promise<SessionRecordV1> {
    const valid = parseSessionRecordV1(record);
    return this.transaction(valid.identity, valid.runtime, (registry) => {
      const records = [...registry.records],
        index = records.findIndex((item) => item.recordId === valid.recordId);
      if (index === -1) {
        records.push(valid);
      } else {
        records[index] = valid;
      }
      return { registry: { ...registry, records }, result: valid };
    });
  }
  async partitions(): Promise<SessionRegistryV1[]> {
    const root = path.join(this.stateRoot, 'sessions', 'v1', 'identities'),
      result: SessionRegistryV1[] = [];
    let domains: string[];
    try {
      domains = await readdir(root);
    } catch (error) {
      if (missing(error)) {
        return [];
      }
      throw error;
    }
    for (const domainEntry of domains.sort()) {
      if (!domainEntry.startsWith('d-')) {
        continue;
      }
      const domainPath = path.join(root, domainEntry);
      if ((await lstat(domainPath)).isSymbolicLink()) {
        continue;
      }
      for (const nameEntry of (await readdir(domainPath)).sort()) {
        if (!nameEntry.startsWith('n-')) {
          continue;
        }
        const identity = {
          domain: decode(domainEntry.slice(2)),
          name: decode(nameEntry.slice(2)),
        };
        for (const runtime of ['claude', 'pi'] as const) {
          const registry = await this.read(identity, runtime);
          if (registry.records.length) {
            result.push(registry);
          }
        }
      }
    }
    return result;
  }
  async listNativeBindings(): Promise<NativeBindingRecordV1[]> {
    const directory = path.join(this.stateRoot, 'sessions', 'v1', 'private', 'native-bindings');
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (missing(error)) {
        return [];
      }
      throw error;
    }
    const result: NativeBindingRecordV1[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const full = path.join(directory, file),
        info = await lstat(full);
      if (info.isSymbolicLink() || !info.isFile()) {
        continue;
      }
      result.push(parseNativeBindingRecordV1(await this.readJson(full)));
    }
    return result;
  }
  async saveNativeBinding(value: NativeBindingRecordV1): Promise<void> {
    const valid = parseNativeBindingRecordV1(value);
    await this.withLock(this.nativeBindingPath(valid.ref), () =>
      this.atomicJson(this.nativeBindingPath(valid.ref), valid),
    );
  }
  async readNativeBinding(ref: string): Promise<NativeBindingRecordV1> {
    try {
      return parseNativeBindingRecordV1(await this.readJson(this.nativeBindingPath(ref)));
    } catch (error) {
      if (missing(error)) {
        throw new SessionError(
          'SESSION_NATIVE_BINDING_NOT_FOUND',
          'recorded native binding was not found',
        );
      }
      throw error;
    }
  }
  async listLifecycleBindingIds(): Promise<string[]> {
    const directory = path.join(this.stateRoot, 'sessions', 'v1', 'private', 'lifecycle-bindings');
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (missing(error)) {
        return [];
      }
      throw error;
    }
    const result: string[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const full = path.join(directory, file);
      const info = await lstat(full);
      if (info.isSymbolicLink() || !info.isFile()) {
        continue;
      }
      result.push(decode(file.slice(0, -5)));
    }
    return result;
  }
  async saveLifecycleBinding(value: SessionLifecycleBindingRecordV1): Promise<void> {
    const valid = parseLifecycleBindingRecordV1(value);
    await this.withLock(this.lifecycleBindingPath(valid.binding.bindingId), () =>
      this.atomicJson(this.lifecycleBindingPath(valid.binding.bindingId), valid),
    );
  }
  async readLifecycleBinding(bindingId: string): Promise<SessionLifecycleBindingRecordV1> {
    try {
      return parseLifecycleBindingRecordV1(
        await this.readJson(this.lifecycleBindingPath(bindingId)),
      );
    } catch (error) {
      if (missing(error)) {
        throw new SessionError(
          'SESSION_LIFECYCLE_BINDING_NOT_FOUND',
          'lifecycle binding was not found',
        );
      }
      throw error;
    }
  }
  async saveCapture(value: SessionCaptureV1): Promise<void> {
    const valid = parseSessionCaptureV1(value);
    await this.withLock(this.capturePath(valid.identity, valid.runtime, valid.captureId), () =>
      this.atomicJson(this.capturePath(valid.identity, valid.runtime, valid.captureId), valid),
    );
  }
  async serializeImport<T>(digest: string, action: () => Promise<T>): Promise<T> {
    return this.withLock(`${this.receiptPath(digest)}.transaction`, action);
  }
  async readImportJournal(digest: string): Promise<LegacyImportJournalV1 | undefined> {
    try {
      const value = parseLegacyImportJournalV1(await this.readJson(this.journalPath(digest)));
      if (value.confirmationDigest !== digest) {
        throw new SessionError('SESSION_INVALID_SCHEMA', 'journal digest does not match its file');
      }
      return value;
    } catch (error) {
      if (missing(error)) {
        return undefined;
      }
      throw error;
    }
  }
  async saveImportJournal(digest: string, value: LegacyImportJournalV1): Promise<void> {
    const valid = parseLegacyImportJournalV1(value);
    if (valid.confirmationDigest !== digest) {
      throw new SessionError('SESSION_INVALID_SCHEMA', 'journal digest does not match its file');
    }
    await this.atomicJson(this.journalPath(digest), valid);
  }
  async removeImportJournal(digest: string): Promise<void> {
    await rm(this.journalPath(digest), { force: true });
  }
  async readReceipt(digest: string): Promise<LegacyImportReceiptV1 | undefined> {
    try {
      const receipt = parseLegacyImportReceiptV1(await this.readJson(this.receiptPath(digest)));
      if (receipt.confirmationDigest !== digest) {
        throw new SessionError(
          'SESSION_INVALID_SCHEMA',
          'receipt confirmation digest does not match its file',
        );
      }
      return receipt;
    } catch (error) {
      if (missing(error)) {
        return undefined;
      }
      throw error;
    }
  }
  async saveReceipt(digest: string, value: LegacyImportReceiptV1): Promise<LegacyImportReceiptV1> {
    const valid = parseLegacyImportReceiptV1(value);
    if (valid.confirmationDigest !== digest) {
      throw new SessionError(
        'SESSION_INVALID_SCHEMA',
        'receipt confirmation digest does not match its file',
      );
    }
    return this.withLock(this.receiptPath(digest), async () => {
      const existing = await this.readReceipt(digest);
      if (existing !== undefined) {
        return existing;
      }
      await this.atomicJson(this.receiptPath(digest), valid);
      return value;
    });
  }
  async readBoundedRegularJson(file: string, maximumBytes: number): Promise<unknown> {
    return this.readJson(file, maximumBytes);
  }
}
