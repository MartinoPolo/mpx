import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { MpxError } from '@mpx/core';

const SCHEMA = 1;
const VERSION = 1;
const KIND = 'pi-legacy-detach';
const JOURNAL = 'pi-legacy-detach.journal.json';
const RECEIPT = 'pi-legacy-detach.receipt.json';
const LOCK = 'pi-legacy-detach.lock';
const STEP_COUNT = 26;
const MAX_STATE_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const UNJOURNALED_STAGE =
  /^\.mpx-legacy-detach-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[01]-(?:[0-9]|1[0-2])\.stage$/iu;

type EntryKind = 'empty' | 'file' | 'tree';
type CrashPoint =
  | 'staged'
  | 'journaled'
  | 'backed-up'
  | 'installed'
  | 'recorded'
  | 'committed'
  | 'backup-removed'
  | 'receipted';
interface InventoryEntry {
  readonly repo: 'mpx-pi' | 'mpx-claude-code';
  /** Exact historical target required from the legacy symlink. */
  readonly source: string;
  /** Exact relocated tree whose bytes are materialized, when distinct from the link target. */
  readonly materializationSource?: string;
  readonly destination: string;
  readonly kind: EntryKind;
}
interface ExpectedOutput {
  readonly kind: EntryKind;
  readonly size: number;
  readonly digest: string;
}

const INVENTORY: readonly InventoryEntry[] = [
  { repo: 'mpx-pi', source: 'agents', destination: 'agents', kind: 'empty' },
  { repo: 'mpx-pi', source: 'extensions', destination: 'extensions', kind: 'empty' },
  { repo: 'mpx-pi', source: 'prompts', destination: 'prompts', kind: 'empty' },
  { repo: 'mpx-pi', source: 'themes', destination: 'themes', kind: 'empty' },
  { repo: 'mpx-pi', source: 'APPEND_SYSTEM.md', destination: 'APPEND_SYSTEM.md', kind: 'file' },
  { repo: 'mpx-pi', source: 'keybindings.json', destination: 'keybindings.json', kind: 'file' },
  { repo: 'mpx-pi', source: 'settings.json', destination: 'settings.json', kind: 'file' },
  { repo: 'mpx-pi', source: 'subagents.json', destination: 'subagents.json', kind: 'file' },
  { repo: 'mpx-pi', source: 'skills/mp-symlink', destination: 'skills/mp-symlink', kind: 'tree' },
  {
    repo: 'mpx-pi',
    source: 'skills/mp-sync-base',
    destination: 'skills/mp-sync-base',
    kind: 'tree',
  },
  {
    repo: 'mpx-claude-code',
    source: 'instructions/AGENTS.md',
    destination: 'AGENTS.md',
    kind: 'file',
  },
  {
    repo: 'mpx-claude-code',
    source: 'skills/mp-fallow-fix',
    materializationSource: 'plugins/mp/skills/mp-fallow-fix',
    destination: 'skills/mp-fallow-fix',
    kind: 'tree',
  },
  {
    repo: 'mpx-claude-code',
    source: 'skills/mp-vocabulary',
    materializationSource: 'plugins/mp/skills/mp-vocabulary',
    destination: 'skills/mp-vocabulary',
    kind: 'tree',
  },
];

export interface PiLegacyDetachConfig {
  readonly identities: Readonly<
    Record<string, { readonly domain: string; readonly runtimeRoots: { readonly pi: string } }>
  >;
}

export interface PiLegacyDetachOptions {
  readonly config: PiLegacyDetachConfig;
  /** Absolute checkout parent containing mpx-pi and mpx-claude-code. */
  readonly projectsRoot: string;
  /** Existing private MPX state directory. */
  readonly stateRoot: string;
  /** Test-only fault simulation; mutation points model abrupt process termination. */
  readonly testCrash?: (point: CrashPoint, stepId?: string) => void;
}

interface Step {
  readonly id: string;
  readonly entry: InventoryEntry;
  readonly source: string;
  readonly materializationSource: string;
  readonly destination: string;
  readonly stage: string;
  readonly backup: string;
}
interface Journal {
  schema: number;
  kind: string;
  inventoryVersion: number;
  transactionId: string;
  phase: 'prepared' | 'committed';
  stepIds: string[];
  expectedOutputs: Record<string, ExpectedOutput>;
  completedStepIds: string[];
  inFlightId?: string;
}
interface Receipt {
  schema: number;
  kind: string;
  inventoryVersion: number;
  completedStepIds: string[];
  completedAt: string;
}

class InjectedCrash extends Error {}
const failure = (code: string, message: string): MpxError => new MpxError({ code, message });
const normalized = (value: string): string =>
  path
    .normalize(value)
    .replace(/[\\/]+$/u, '')
    .toLowerCase();
const exists = async (target: string) =>
  lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? false : Promise.reject(error)),
  );
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
};

/**
 * Flush a directory entry update where Node and the host support it. Windows does not
 * provide portable directory handles; only its unsupported-operation results are ignored.
 * This narrows, but cannot eliminate, the power-loss window around metadata updates.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EISDIR', 'EINVAL', 'EPERM'].includes(code ?? '')) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function durableWrite(target: string, bytes: string | Buffer): Promise<void> {
  const handle = await open(target, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(target));
}

async function durableRename(from: string, to: string): Promise<void> {
  await rename(from, to);
  await syncDirectory(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) {
    await syncDirectory(path.dirname(from));
  }
}

async function durableUnlink(target: string): Promise<void> {
  await unlink(target);
  await syncDirectory(path.dirname(target));
}

async function requireRealDirectory(
  target: string,
  code = 'PI_LEGACY_ROOT_INVALID',
): Promise<void> {
  try {
    if (!path.isAbsolute(target)) {
      throw new Error();
    }
    const info = await lstat(target);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      normalized(await realpath(target)) !== normalized(target)
    ) {
      throw new Error();
    }
  } catch {
    throw failure(code, 'A required real directory is unavailable.');
  }
}

async function safeSourceNode(target: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch {
    throw failure('PI_LEGACY_SOURCE_INVALID', 'A migration source is unsafe.');
  }
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw failure('PI_LEGACY_SOURCE_INVALID', 'A migration source is unsafe.');
  }
  try {
    if (normalized(await realpath(target)) !== normalized(target)) {
      throw new Error();
    }
  } catch {
    throw failure('PI_LEGACY_SOURCE_INVALID', 'A migration source is unsafe.');
  }
  if (info.isDirectory()) {
    for (const name of await readdir(target)) {
      await safeSourceNode(path.join(target, name));
    }
  }
}

async function durableMkdir(target: string): Promise<void> {
  await mkdir(target);
  await syncDirectory(path.dirname(target));
}

async function copyTree(source: string, destination: string): Promise<void> {
  await durableMkdir(destination);
  for (const name of (await readdir(source)).sort()) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const info = await lstat(from);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await copyTree(from, to);
    } else if (info.isFile() && !info.isSymbolicLink()) {
      await durableWrite(to, await readFile(from));
    } else {
      throw failure('PI_LEGACY_SOURCE_INVALID', 'A migration source is unsafe.');
    }
  }
  await syncDirectory(destination);
}

function hashFrame(hash: ReturnType<typeof createHash>, tag: string, value: Buffer): void {
  hash.update(tag);
  hash.update(String(value.length));
  hash.update(':');
  hash.update(value);
}

async function evidenceFor(target: string, kind: EntryKind): Promise<ExpectedOutput> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    throw new Error('unsafe output');
  }
  if (kind === 'file') {
    if (!info.isFile()) {
      throw new Error('wrong output kind');
    }
    const bytes = await readFile(target);
    return { kind, size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
  }
  if (!info.isDirectory()) {
    throw new Error('wrong output kind');
  }
  const names = (await readdir(target)).sort();
  if (kind === 'empty' && names.length !== 0) {
    throw new Error('non-empty output');
  }
  const hash = createHash('sha256');
  let size = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) {
        throw new Error('unsafe output');
      }
      const encodedName = Buffer.from(name, 'utf8');
      if (childInfo.isDirectory()) {
        hashFrame(hash, 'D', encodedName);
        await visit(child);
        hash.update('E');
      } else if (childInfo.isFile()) {
        const bytes = await readFile(child);
        hashFrame(hash, 'F', encodedName);
        hashFrame(hash, 'B', bytes);
        size += bytes.length;
      } else {
        throw new Error('unsafe output');
      }
    }
  };
  await visit(target);
  return { kind, size, digest: hash.digest('hex') };
}

async function outputMatches(target: string, expected: ExpectedOutput): Promise<boolean> {
  try {
    const actual = await evidenceFor(target, expected.kind);
    return actual.size === expected.size && actual.digest === expected.digest;
  } catch {
    return false;
  }
}

async function linkMatches(step: Step, target = step.destination): Promise<boolean> {
  try {
    const info = await lstat(target);
    if (!info.isSymbolicLink()) {
      return false;
    }
    const linkTarget = await readlink(target);
    if (normalized(path.resolve(path.dirname(target), linkTarget)) !== normalized(step.source)) {
      return false;
    }
    if (step.entry.materializationSource !== undefined) {
      return true;
    }
    const followed = await stat(target);
    return step.entry.kind === 'file' ? followed.isFile() : followed.isDirectory();
  } catch {
    return false;
  }
}

async function removeVerifiedRealOutput(step: Step, expected: ExpectedOutput): Promise<void> {
  if (!(await outputMatches(step.destination, expected))) {
    throw failure('PI_LEGACY_RECOVERY_INVALID', 'Migration recovery state is invalid.');
  }
  if (expected.kind === 'file') {
    await durableUnlink(step.destination);
  } else {
    await rm(step.destination, { recursive: true });
    await syncDirectory(path.dirname(step.destination));
  }
}

async function atomicJson(target: string, value: Journal | Receipt): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await durableWrite(temporary, `${JSON.stringify(value)}\n`);
  try {
    await durableRename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function parseBoundedJson(
  body: Buffer,
  stateCode: string,
  stateMessage: string,
): Record<string, unknown> {
  try {
    if (body.length === 0 || body.length > MAX_STATE_BYTES) {
      throw new Error();
    }
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (!isRecord(value)) {
      throw new Error();
    }
    return value;
  } catch {
    throw failure(stateCode, stateMessage);
  }
}

function parseJournal(body: Buffer): Journal {
  const invalid = () => failure('PI_LEGACY_STATE_INVALID', 'The migration state is invalid.');
  try {
    const value = parseBoundedJson(
      body,
      'PI_LEGACY_STATE_INVALID',
      'The migration state is invalid.',
    );
    const allowed = [
      'schema',
      'kind',
      'inventoryVersion',
      'transactionId',
      'phase',
      'stepIds',
      'expectedOutputs',
      'completedStepIds',
      ...(value.inFlightId === undefined ? [] : ['inFlightId']),
    ];
    if (!exactKeys(value, allowed)) {
      throw new Error();
    }
    const stepIds = value.stepIds;
    const completed = value.completedStepIds;
    const outputs = value.expectedOutputs;
    if (
      value.schema !== SCHEMA ||
      value.kind !== KIND ||
      value.inventoryVersion !== VERSION ||
      !UUID.test(String(value.transactionId)) ||
      !['prepared', 'committed'].includes(String(value.phase)) ||
      !Array.isArray(stepIds) ||
      stepIds.length !== STEP_COUNT ||
      stepIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(stepIds).size !== STEP_COUNT ||
      !Array.isArray(completed) ||
      completed.length > STEP_COUNT ||
      completed.some((id, index) => id !== stepIds[index]) ||
      !isRecord(outputs) ||
      !exactKeys(outputs, stepIds)
    ) {
      throw new Error();
    }
    for (const id of stepIds) {
      const evidence = outputs[id];
      if (
        !isRecord(evidence) ||
        !exactKeys(evidence, ['kind', 'size', 'digest']) ||
        !['empty', 'file', 'tree'].includes(String(evidence.kind)) ||
        !Number.isSafeInteger(evidence.size) ||
        (evidence.size as number) < 0 ||
        !SHA256.test(String(evidence.digest))
      ) {
        throw new Error();
      }
    }
    const inFlight = value.inFlightId;
    if (
      (inFlight !== undefined &&
        (typeof inFlight !== 'string' || inFlight !== stepIds[completed.length])) ||
      (value.phase === 'committed' && (completed.length !== STEP_COUNT || inFlight !== undefined))
    ) {
      throw new Error();
    }
    return value as unknown as Journal;
  } catch {
    throw invalid();
  }
}

export class PiLegacyDetachService {
  constructor(private readonly options: PiLegacyDetachOptions) {}

  private roots(): [string, string] {
    const identities = Object.values(this.options.config.identities);
    const personal = identities.filter((item) => item.domain === 'personal');
    const work = identities.filter((item) => item.domain === 'work');
    if (personal.length !== 1 || work.length !== 1) {
      throw failure('PI_LEGACY_ROOT_INVALID', 'The two Pi roots could not be resolved.');
    }
    const roots: [string, string] = [personal[0]!.runtimeRoots.pi, work[0]!.runtimeRoots.pi];
    if (normalized(roots[0]) === normalized(roots[1])) {
      throw failure('PI_LEGACY_ROOT_INVALID', 'The two Pi roots could not be resolved.');
    }
    return roots;
  }

  private steps(roots: [string, string], transactionId: string, stepIds: string[]): Step[] {
    let ordinal = 0;
    return roots.flatMap((root, role) =>
      INVENTORY.map((entry, index) => {
        const id = stepIds[ordinal++]!;
        const destination = path.join(root, entry.destination);
        const marker = `.mpx-legacy-detach-${transactionId}-${role}-${index}`;
        return {
          id,
          entry,
          source: path.join(this.options.projectsRoot, entry.repo, entry.source),
          materializationSource: path.join(
            this.options.projectsRoot,
            entry.repo,
            entry.materializationSource ?? entry.source,
          ),
          destination,
          stage: path.join(path.dirname(destination), `${marker}.stage`),
          backup: path.join(path.dirname(destination), `${marker}.backup`),
        };
      }),
    );
  }

  private crash(point: CrashPoint, stepId?: string): void {
    try {
      this.options.testCrash?.(point, stepId);
    } catch {
      throw new InjectedCrash();
    }
  }

  async run(): Promise<void> {
    let release: (() => Promise<void>) | undefined;
    try {
      await requireRealDirectory(this.options.stateRoot, 'PI_LEGACY_STATE_INVALID');
      const lockPath = path.join(this.options.stateRoot, LOCK);
      if (!(await exists(lockPath))) {
        await (await open(lockPath, 'wx')).close();
      } else if (!(await lstat(lockPath)).isFile() || (await lstat(lockPath)).isSymbolicLink()) {
        throw failure('PI_LEGACY_STATE_INVALID', 'The migration state is invalid.');
      }
      release = await lockfile.lock(lockPath, {
        realpath: false,
        retries: { retries: 0 },
        stale: 10_000,
      });
      await this.runLocked();
    } catch (error) {
      if (error instanceof InjectedCrash) {
        throw failure('PI_LEGACY_CRASH_INJECTED', 'The migration was interrupted.');
      }
      if (error instanceof MpxError) {
        throw error;
      }
      throw failure('PI_LEGACY_OPERATION_FAILED', 'The legacy Pi detachment failed.');
    } finally {
      await release?.().catch(() => undefined);
    }
  }

  private async runLocked(): Promise<void> {
    const roots = this.roots();
    await Promise.all([
      ...roots.map((root) => requireRealDirectory(root)),
      ...roots.map((root) => requireRealDirectory(path.join(root, 'skills'))),
    ]);
    if (!path.isAbsolute(this.options.projectsRoot)) {
      throw failure('PI_LEGACY_SOURCE_INVALID', 'A migration source is unsafe.');
    }
    const journalPath = path.join(this.options.stateRoot, JOURNAL);
    const receiptPath = path.join(this.options.stateRoot, RECEIPT);
    if (await exists(receiptPath)) {
      const receipt = await this.readReceipt(receiptPath);
      const steps = this.steps(roots, 'receipt', receipt.completedStepIds);
      if (!(await this.allOutputKindsMatch(steps))) {
        throw failure(
          'PI_LEGACY_RECEIPT_INVALID',
          'The completed migration could not be verified.',
        );
      }
      if (await exists(journalPath)) {
        const stale = parseJournal(await readFile(journalPath));
        const staleSteps = this.steps(roots, stale.transactionId, stale.stepIds);
        if (
          stale.phase !== 'committed' ||
          stale.stepIds.some((id, index) => id !== receipt.completedStepIds[index]) ||
          staleSteps.some((step) => stale.expectedOutputs[step.id]!.kind !== step.entry.kind)
        ) {
          throw failure('PI_LEGACY_STATE_INVALID', 'The migration state is invalid.');
        }
        await durableUnlink(journalPath);
      }
      return;
    }
    if (await exists(journalPath)) {
      const journal = parseJournal(await readFile(journalPath));
      const steps = this.steps(roots, journal.transactionId, journal.stepIds);
      if (steps.some((step) => journal.expectedOutputs[step.id]!.kind !== step.entry.kind)) {
        throw failure('PI_LEGACY_STATE_INVALID', 'The migration state is invalid.');
      }
      if (journal.phase === 'committed') {
        await this.finishCommitted(journal, steps, journalPath, receiptPath);
      } else {
        await this.rollback(journal, steps, journalPath);
      }
      return;
    }
    await this.requireNoUnjournaledStages(roots);
    await this.migrate(roots, journalPath, receiptPath);
  }

  private async requireNoUnjournaledStages(roots: [string, string]): Promise<void> {
    const parents = new Set(
      roots.flatMap((root) =>
        INVENTORY.map((entry) => path.dirname(path.join(root, entry.destination))),
      ),
    );
    for (const parent of parents) {
      if ((await readdir(parent)).some((name) => UNJOURNALED_STAGE.test(name))) {
        throw failure(
          'PI_LEGACY_CLEANUP_REQUIRED',
          'The legacy Pi migration requires safe cleanup.',
        );
      }
    }
  }

  private async readReceipt(target: string): Promise<Receipt> {
    const message = 'The completed migration could not be verified.';
    try {
      const value = parseBoundedJson(await readFile(target), 'PI_LEGACY_RECEIPT_INVALID', message);
      if (
        !exactKeys(value, [
          'schema',
          'kind',
          'inventoryVersion',
          'completedStepIds',
          'completedAt',
        ]) ||
        value.schema !== SCHEMA ||
        value.kind !== KIND ||
        value.inventoryVersion !== VERSION ||
        !Array.isArray(value.completedStepIds) ||
        value.completedStepIds.length !== STEP_COUNT ||
        value.completedStepIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
        new Set(value.completedStepIds).size !== STEP_COUNT ||
        typeof value.completedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.completedAt)) ||
        new Date(value.completedAt).toISOString() !== value.completedAt
      ) {
        throw new Error();
      }
      return value as unknown as Receipt;
    } catch {
      throw failure('PI_LEGACY_RECEIPT_INVALID', message);
    }
  }

  private async preflight(steps: Step[]): Promise<void> {
    const uniqueSources = new Set<string>();
    for (const step of steps) {
      if (!(await linkMatches(step))) {
        throw failure(
          'PI_LEGACY_INVENTORY_INVALID',
          'The complete legacy Pi inventory is not present.',
        );
      }
      uniqueSources.add(step.materializationSource);
    }
    for (const step of steps) {
      if (uniqueSources.delete(step.materializationSource)) {
        await safeSourceNode(step.materializationSource);
        const info = await lstat(step.materializationSource);
        if ((step.entry.kind === 'file') !== info.isFile()) {
          throw failure('PI_LEGACY_SOURCE_INVALID', 'A migration source is unsafe.');
        }
      }
    }
  }

  private async stage(step: Step): Promise<void> {
    if (step.entry.kind === 'empty') {
      await durableMkdir(step.stage);
    } else if (step.entry.kind === 'file') {
      await durableWrite(step.stage, await readFile(step.materializationSource));
    } else {
      await copyTree(step.materializationSource, step.stage);
    }
  }

  private async migrate(
    roots: [string, string],
    journalPath: string,
    receiptPath: string,
  ): Promise<void> {
    const transactionId = randomUUID();
    const stepIds = Array.from({ length: STEP_COUNT }, () => randomUUID());
    const steps = this.steps(roots, transactionId, stepIds);
    await this.preflight(steps);
    try {
      for (const step of steps) {
        await this.stage(step);
        // Unlike mutation crash points, this hook models an ordinary staging failure so
        // tests exercise the pre-journal failure path rather than abrupt termination.
        this.options.testCrash?.('staged', step.id);
      }
      const expectedOutputs: Record<string, ExpectedOutput> = {};
      for (const step of steps) {
        expectedOutputs[step.id] = await evidenceFor(step.stage, step.entry.kind);
      }
      const journal: Journal = {
        schema: SCHEMA,
        kind: KIND,
        inventoryVersion: VERSION,
        transactionId,
        phase: 'prepared',
        stepIds,
        expectedOutputs,
        completedStepIds: [],
      };
      await atomicJson(journalPath, journal);
      // Staging can take time: close the whole-inventory validation window immediately
      // before mutation, then validate the exact link again at every rename boundary.
      await this.preflight(steps);
      for (const step of steps) {
        journal.inFlightId = step.id;
        await atomicJson(journalPath, journal);
        this.crash('journaled', step.id);
        if (!(await linkMatches(step))) {
          throw failure(
            'PI_LEGACY_INVENTORY_DRIFT',
            'The legacy Pi inventory changed during migration.',
          );
        }
        await durableRename(step.destination, step.backup);
        this.crash('backed-up', step.id);
        await durableRename(step.stage, step.destination);
        this.crash('installed', step.id);
        journal.completedStepIds.push(step.id);
        delete journal.inFlightId;
        await atomicJson(journalPath, journal);
        this.crash('recorded', step.id);
      }
      if (!(await this.allOutputsMatch(steps, journal.expectedOutputs))) {
        throw failure(
          'PI_LEGACY_VERIFY_FAILED',
          'The detached Pi inventory could not be verified.',
        );
      }
      journal.phase = 'committed';
      await atomicJson(journalPath, journal);
      this.crash('committed');
      await this.finishCommitted(journal, steps, journalPath, receiptPath);
    } catch (error) {
      if (error instanceof InjectedCrash) {
        throw error;
      }
      if (await exists(journalPath)) {
        try {
          const persisted = parseJournal(await readFile(journalPath));
          if (persisted.phase === 'prepared') {
            await this.rollback(persisted, steps, journalPath);
          }
        } catch {
          throw failure(
            'PI_LEGACY_RECOVERY_FAILED',
            'The legacy Pi migration requires safe recovery.',
          );
        }
      }
      // Before the first journal exists, stage paths have no persisted ownership evidence.
      // Leave them fail-closed: a concurrent process may have replaced any pathname.
      throw error;
    }
  }

  private async allOutputsMatch(
    steps: Step[],
    outputs: Record<string, ExpectedOutput>,
  ): Promise<boolean> {
    for (const step of steps) {
      if (!(await outputMatches(step.destination, outputs[step.id]!))) {
        return false;
      }
    }
    return true;
  }

  private async allOutputKindsMatch(steps: Step[]): Promise<boolean> {
    for (const step of steps) {
      try {
        const info = await lstat(step.destination);
        if (
          info.isSymbolicLink() ||
          (step.entry.kind === 'file' ? !info.isFile() : !info.isDirectory())
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private async rollback(journal: Journal, steps: Step[], journalPath: string): Promise<void> {
    const affected = [
      ...journal.completedStepIds,
      ...(journal.inFlightId ? [journal.inFlightId] : []),
    ];
    let invalid = false;
    for (const id of [...new Set(affected)].reverse()) {
      const step = steps.find((candidate) => candidate.id === id)!;
      const backup = await exists(step.backup);
      if (!backup) {
        // A foreign node may have appeared after preflight. Never move or remove it,
        // but continue restoring earlier steps before reporting the drift.
        if (!(await linkMatches(step))) {
          invalid = true;
        }
        continue;
      }
      if (!(await linkMatches(step, step.backup))) {
        invalid = true;
        continue;
      }
      if (await exists(step.destination)) {
        if (!(await outputMatches(step.destination, journal.expectedOutputs[id]!))) {
          invalid = true;
          continue;
        }
        await removeVerifiedRealOutput(step, journal.expectedOutputs[id]!);
      }
      await durableRename(step.backup, step.destination);
    }
    for (const step of steps) {
      if (await exists(step.stage)) {
        const expected = journal.expectedOutputs[step.id]!;
        if (!(await outputMatches(step.stage, expected))) {
          invalid = true;
          continue;
        }
        if (expected.kind === 'file') {
          await durableUnlink(step.stage);
        } else {
          await rm(step.stage, { recursive: true });
          await syncDirectory(path.dirname(step.stage));
        }
      }
    }
    if (invalid) {
      throw failure('PI_LEGACY_RECOVERY_INVALID', 'Migration recovery state is invalid.');
    }
    await durableUnlink(journalPath);
  }

  private async finishCommitted(
    journal: Journal,
    steps: Step[],
    journalPath: string,
    receiptPath: string,
  ): Promise<void> {
    if (!(await this.allOutputsMatch(steps, journal.expectedOutputs))) {
      throw failure('PI_LEGACY_RECOVERY_INVALID', 'Migration recovery state is invalid.');
    }
    for (const step of steps) {
      if (await exists(step.backup)) {
        if (!(await linkMatches(step, step.backup))) {
          throw failure('PI_LEGACY_RECOVERY_INVALID', 'Migration recovery state is invalid.');
        }
        await durableUnlink(step.backup);
        this.crash('backup-removed', step.id);
      }
    }
    const receipt: Receipt = {
      schema: SCHEMA,
      kind: KIND,
      inventoryVersion: VERSION,
      completedStepIds: journal.stepIds,
      completedAt: new Date().toISOString(),
    };
    await atomicJson(receiptPath, receipt);
    this.crash('receipted');
    await durableUnlink(journalPath);
  }
}
