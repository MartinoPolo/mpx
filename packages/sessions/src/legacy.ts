import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeName } from '@mpx/runtime-contracts';
import { SessionStore } from './store.js';
import {
  SessionError,
  canonicalTimestamp,
  parseSessionRecordV1,
  stableDigest,
  type IdentityV1,
  type LegacyImportReceiptV1,
  type SessionRecordV1,
} from './schemas.js';

export interface LegacyMapping {
  readonly identity: IdentityV1;
  readonly nativeBindingRef: string;
  /** Planning-only native root used to prove and relativize Pi session files. */
  readonly nativeRoot?: string;
}
export type LegacyMappings = Readonly<Record<string, LegacyMapping>>;
export interface LegacyImportPlanV1 {
  readonly schemaVersion: 1;
  readonly sources: readonly Readonly<{
    sourceKey: string;
    sha256: string;
    bytes: number;
  }>[];
  readonly records: readonly SessionRecordV1[];
  readonly quarantine: readonly Readonly<{
    sourceKey: string;
    index: number;
    code: string;
  }>[];
  readonly confirmationDigest: string;
}
interface SourceEvidence {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}
const permissionModes = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
const maxSourceBytes = 10 * 1024 * 1024;
const evidence = new WeakMap<LegacyImportPlanV1, readonly SourceEvidence[]>();

async function safeRead(file: string): Promise<{ content: Buffer; sha256: string; bytes: number }> {
  const linked = await lstat(file);
  if (linked.isSymbolicLink() || !linked.isFile() || linked.size > maxSourceBytes) {
    throw new SessionError(
      'LEGACY_SOURCE_UNSAFE',
      'legacy source must be an explicit bounded regular non-symlink file',
    );
  }
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat(),
      content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const result = await handle.read(content, offset, content.length - offset, offset);
      if (!result.bytesRead) {
        throw new SessionError('LEGACY_SOURCE_CHANGED', 'legacy source changed while reading');
      }
      offset += result.bytesRead;
    }
    const after = await handle.stat(),
      linkedAfter = await lstat(file);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      linkedAfter.isSymbolicLink() ||
      linkedAfter.ino !== before.ino
    ) {
      throw new SessionError('LEGACY_SOURCE_CHANGED', 'legacy source changed while reading');
    }
    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
    };
  } finally {
    await handle.close();
  }
}
function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionError('LEGACY_MALFORMED', `${label} must be an object`);
  }
  const item = value as Record<string, unknown>;
  if (keys.some((key) => !Object.hasOwn(item, key))) {
    throw new SessionError('LEGACY_MALFORMED', `${label} is missing a required field`);
  }
  return item;
}
function text(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw new SessionError('LEGACY_MALFORMED', `${label} is invalid`);
  }
  return value;
}
function optionalText(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : text(value, label);
}
function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
async function mappedPiFile(value: unknown, mapping: LegacyMapping): Promise<string> {
  const source = text(value, 'sessionFile')!;
  if (!path.isAbsolute(source) || !mapping.nativeRoot) {
    throw new SessionError(
      'LEGACY_UNSAFE_SESSION_FILE',
      'Pi legacy sessionFile requires an absolute file and an explicit mapped native root',
    );
  }
  const root = await realpath(mapping.nativeRoot),
    candidate = path.resolve(source);
  if (!contained(root, candidate)) {
    throw new SessionError(
      'LEGACY_UNSAFE_SESSION_FILE',
      'Pi legacy sessionFile escapes its mapped root',
    );
  }
  const linked = await lstat(candidate),
    resolved = await realpath(candidate);
  if (linked.isSymbolicLink() || !linked.isFile() || !contained(root, resolved)) {
    throw new SessionError('LEGACY_UNSAFE_SESSION_FILE', 'Pi legacy sessionFile is unsafe');
  }
  return path.relative(root, candidate).split(path.sep).join('/');
}

export class LegacySessionImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly afterRecordCommitted?: (recordId: string) => Promise<void>,
  ) {}
  async planFiles(files: readonly string[], mappings: LegacyMappings): Promise<LegacyImportPlanV1> {
    if (files.length > 128) {
      throw new SessionError('LEGACY_SOURCE_LIMIT', 'too many legacy source files');
    }
    const sources: LegacyImportPlanV1['sources'][number][] = [],
      records: SessionRecordV1[] = [],
      plannedRecordDigests = new Map<string, string>(),
      quarantine: LegacyImportPlanV1['quarantine'][number][] = [],
      sourceEvidence: SourceEvidence[] = [];
    for (let sourceIndex = 0; sourceIndex < files.length; sourceIndex += 1) {
      const read = await safeRead(files[sourceIndex]!);
      const sourceKey = `source-${sourceIndex + 1}-${read.sha256.slice(0, 12)}`;
      sources.push({ sourceKey, sha256: read.sha256, bytes: read.bytes });
      sourceEvidence.push({
        file: files[sourceIndex]!,
        sha256: read.sha256,
        bytes: read.bytes,
      });
      const parsed = JSON.parse(read.content.toString('utf8')) as unknown;
      const candidate =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      const isPiRegistry = candidate.version === 2 && candidate.agent === 'pi';
      if (isPiRegistry) {
        const allowed = [
          'version',
          'agent',
          'sessionId',
          'sessionFile',
          'cwd',
          'name',
          'pid',
          'processStartedAt',
          'registeredAt',
        ];
        const required = allowed.filter((key) => key !== 'name');
        if (
          Object.keys(candidate).some((key) => !allowed.includes(key)) ||
          required.some((key) => !Object.hasOwn(candidate, key))
        ) {
          throw new SessionError(
            'LEGACY_MALFORMED',
            'Pi active registry entry has an inexact shape',
          );
        }
      }
      const root = isPiRegistry
        ? { schemaVersion: 2, savedAt: candidate.registeredAt, sessions: [parsed] }
        : object(parsed, ['schemaVersion', 'savedAt', 'sessions'], 'agent-resurrect save group');
      if (
        root.schemaVersion !== 2 ||
        !Array.isArray(root.sessions) ||
        root.sessions.length > 10_000
      ) {
        throw new SessionError(
          'LEGACY_MALFORMED',
          'legacy source is neither save-group v2 nor Pi active-registry v2',
        );
      }
      const savedAt = canonicalTimestamp(
        root.savedAt === null ? this.clock() : root.savedAt,
        'savedAt',
      );
      for (let index = 0; index < root.sessions.length; index += 1) {
        try {
          const converted = await this.convert(
            root.sessions[index],
            mappings,
            savedAt,
            mappings[`pi:${files[sourceIndex]!}`] ?? mappings[`pi:${sourceKey}`],
          );
          const convertedDigest = stableDigest(converted),
            priorDigest = plannedRecordDigests.get(converted.recordId);
          if (priorDigest === undefined) {
            plannedRecordDigests.set(converted.recordId, convertedDigest);
            records.push(converted);
          } else if (priorDigest !== convertedDigest) {
            quarantine.push({ sourceKey, index, code: 'LEGACY_DUPLICATE_CONFLICT' });
          }
        } catch (error) {
          quarantine.push({
            sourceKey,
            index,
            code: error instanceof SessionError ? error.code : 'LEGACY_MALFORMED',
          });
        }
      }
    }
    const unsigned = {
        schemaVersion: 1 as const,
        sources,
        records,
        quarantine,
      },
      plan: LegacyImportPlanV1 = {
        ...unsigned,
        confirmationDigest: stableDigest(unsigned),
      };
    evidence.set(plan, sourceEvidence);
    return plan;
  }
  private async convert(
    value: unknown,
    mappings: LegacyMappings,
    savedAt: string,
    piSourceMapping?: LegacyMapping,
  ): Promise<SessionRecordV1> {
    const item = object(value, ['agent', 'sessionId', 'cwd'], 'legacy session');
    const runtime = text(item.agent, 'agent') as RuntimeName;
    if (runtime !== 'claude' && runtime !== 'pi') {
      throw new SessionError('LEGACY_AGENT_UNSUPPORTED', 'legacy agent is unsupported');
    }
    const account = optionalText(item.account, 'account'),
      mapping =
        runtime === 'pi'
          ? (piSourceMapping ??
            (account === null ? mappings.pi : (mappings[`pi:${account}`] ?? mappings.pi)))
          : account === null
            ? undefined
            : (mappings[`${runtime}:${account}`] ?? mappings[account]);
    if (!mapping) {
      throw new SessionError(
        'LEGACY_MAPPING_REQUIRED',
        runtime === 'claude'
          ? 'Claude legacy session requires an account with an explicit MPX mapping'
          : "Pi legacy session requires the explicit 'pi' mapping",
      );
    }
    const binding = await this.store.readNativeBinding(mapping.nativeBindingRef);
    if (
      binding.runtime !== runtime ||
      binding.identity.domain !== mapping.identity.domain ||
      binding.identity.name !== mapping.identity.name
    ) {
      throw new SessionError(
        'LEGACY_MAPPING_MISMATCH',
        'legacy mapping does not match existing native binding',
      );
    }
    const permissionMode = optionalText(item.permissionMode, 'permissionMode');
    if (permissionMode !== null && !permissionModes.has(permissionMode)) {
      throw new SessionError('LEGACY_PERMISSION_MODE', 'legacy permissionMode is not allowlisted');
    }
    const sessionId = text(item.sessionId, 'sessionId')!,
      sessionFile = runtime === 'pi' ? await mappedPiFile(item.sessionFile, mapping) : null,
      recordId = `${runtime}-${stableDigest({ identity: mapping.identity, sessionId }).slice(0, 24)}`;
    return parseSessionRecordV1({
      schemaVersion: 1,
      recordId,
      runtimeQualifiedId: `${runtime}:${sessionId}`,
      runtime,
      identity: mapping.identity,
      nativeBindingRef: mapping.nativeBindingRef,
      nativeSessionRef:
        runtime === 'pi'
          ? { kind: 'root-relative-file', value: sessionFile! }
          : { kind: 'native-id', value: sessionId },
      launch: null,
      location: {
        cwd: text(item.cwd, 'cwd')!,
        project: null,
        repository: null,
        worktree: null,
      },
      metadata: {
        title: optionalText(item.name, 'name'),
        model: optionalText(item.model, 'model'),
        effort: optionalText(item.effort, 'effort'),
      },
      liveness: 'unknown',
      process: null,
      workflow: {
        status: 'unfinished',
        inbox: true,
        nextAction: null,
        priority: null,
        note: null,
        relatedIssue: null,
        relatedReview: null,
      },
      resume: {
        state: 'blocked',
        diagnostic: 'LEGACY_IMPORT_REQUIRES_RECORDED_LAUNCH',
        lastVerifiedAt: null,
        lastPlanDigest: null,
      },
      timestamps: {
        createdAt: savedAt,
        updatedAt: savedAt,
        lastActivityAt: null,
      },
      lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    });
  }
  async import(
    plan: LegacyImportPlanV1,
    confirmationDigest: string,
  ): Promise<LegacyImportReceiptV1> {
    const { confirmationDigest: plannedDigest, ...unsigned } = plan;
    if (confirmationDigest !== plannedDigest || stableDigest(unsigned) !== plannedDigest) {
      throw new SessionError(
        'LEGACY_CONFIRMATION_MISMATCH',
        'legacy import confirmation digest does not match',
      );
    }
    return this.store.serializeImport(plannedDigest, async () => {
      const prior = await this.store.readReceipt(plannedDigest);
      if (prior) {
        return { ...prior, imported: 0, skipped: plan.records.length };
      }
      const sourceEvidence = evidence.get(plan);
      if (!sourceEvidence) {
        throw new SessionError(
          'LEGACY_SOURCE_REVALIDATION_REQUIRED',
          'import plan is detached from its explicit source evidence',
        );
      }
      for (const source of sourceEvidence) {
        const current = await safeRead(source.file);
        if (current.sha256 !== source.sha256 || current.bytes !== source.bytes) {
          throw new SessionError('LEGACY_SOURCE_CHANGED', 'legacy source changed after planning');
        }
      }
      const startedAt = this.clock();
      let journal = await this.store.readImportJournal(plannedDigest);
      if (!journal) {
        const dispositions = [];
        for (const record of plan.records) {
          const registry = await this.store.read(record.identity, record.runtime);
          dispositions.push({
            recordId: record.recordId,
            disposition: registry.records.some(
              (candidate) => candidate.recordId === record.recordId,
            )
              ? ('skipped' as const)
              : ('imported' as const),
          });
        }
        journal = {
          schemaVersion: 1,
          confirmationDigest: plannedDigest,
          dispositions,
          committedRecordIds: [],
          partitionKeys: [],
          createdAt: startedAt,
          updatedAt: startedAt,
        };
        await this.store.saveImportJournal(plannedDigest, journal);
      }
      const dispositionRecordIds = new Set(journal.dispositions.map(({ recordId }) => recordId));
      if (
        dispositionRecordIds.size !== plan.records.length ||
        plan.records.some(({ recordId }) => !dispositionRecordIds.has(recordId))
      ) {
        throw new SessionError(
          'SESSION_INVALID_SCHEMA',
          'legacy import journal dispositions do not match the confirmed plan',
        );
      }
      const partitions = new Set<string>(journal.partitionKeys);
      for (const record of plan.records) {
        if (journal.committedRecordIds.includes(record.recordId)) {
          continue;
        }
        const disposition = journal.dispositions.find(
          (candidate) => candidate.recordId === record.recordId,
        );
        if (!disposition) {
          throw new SessionError(
            'SESSION_INVALID_SCHEMA',
            'legacy import journal is missing a planned record disposition',
          );
        }
        await this.store.transaction(record.identity, record.runtime, (registry) => {
          if (
            disposition.disposition === 'skipped' ||
            registry.records.some((candidate) => candidate.recordId === record.recordId)
          ) {
            return { registry, result: undefined };
          }
          return {
            registry: { ...registry, records: [...registry.records, record] },
            result: undefined,
          };
        });
        await this.afterRecordCommitted?.(record.recordId);
        const partitionKey = stableDigest({
          identity: record.identity,
          runtime: record.runtime,
        });
        partitions.add(partitionKey);
        journal = {
          ...journal,
          committedRecordIds: [...journal.committedRecordIds, record.recordId],
          partitionKeys: [...partitions].sort(),
          updatedAt: this.clock(),
        };
        await this.store.saveImportJournal(plannedDigest, journal);
      }
      const receipt: LegacyImportReceiptV1 = {
        schemaVersion: 1,
        confirmationDigest: plannedDigest,
        imported: journal.dispositions.filter(({ disposition }) => disposition === 'imported')
          .length,
        skipped: journal.dispositions.filter(({ disposition }) => disposition === 'skipped').length,
        partitionKeys: [...partitions].sort(),
        createdAt: this.clock(),
      };
      const persisted = await this.store.saveReceipt(plannedDigest, receipt);
      await this.store.removeImportJournal(plannedDigest);
      return persisted === receipt
        ? receipt
        : { ...persisted, imported: 0, skipped: plan.records.length };
    });
  }
}
