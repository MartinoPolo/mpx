import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  createSessionLifecycleEvent,
  parseNativeSessionRef,
  parseRuntimeContext,
  validateSessionLifecycleBinding,
  type SessionLifecycleEvent,
} from '@mpx/runtime-contracts';
import { SESSION_STORE_VERSION } from '@mpx/sessions';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

const maximumEventBytes = 16_384;
const maximumPendingEvents = 900;
const writerKey = Symbol.for('@mpx/session-lifecycle/writers');

type Environment = Readonly<Record<string, string | undefined>>;

type Snapshot = Pick<
  SessionLifecycleEvent,
  'nativeSessionId' | 'nativeSessionRef' | 'cwd' | 'title' | 'model' | 'effort'
>;

interface PathIdentity {
  file: string;
  kind: 'directory' | 'file';
  device: number;
  inode: number;
}

interface Writer {
  queue: Promise<void>;
  directoryBinding: PathIdentity[];
  nativeRootBinding: PathIdentity[];
  sequence: number;
  timestamp: string;
  nativeSessionId: string;
  nativeSessionFile: string;
  cwd: string;
  startFingerprint: string;
  snapshot: Snapshot;
  nativeRoot: string;
  active: boolean;
  retired: boolean;
  replacementWarned: boolean;
  pending: SessionLifecycleEvent[];
}

const processState = globalThis as typeof globalThis & { [writerKey]?: Map<string, Writer> };

function reject(reason: string): never {
  throw new Error(`MPX session lifecycle: ${reason}; restart through MPX.`);
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

async function regularPath(target: string, kind: 'directory' | 'file'): Promise<PathIdentity[]> {
  const identities: PathIdentity[] = [];
  let current = path.resolve(target);
  const resolved = await realpath(current);
  if (!samePath(current, resolved)) {
    reject('linked paths are forbidden');
  }
  let leaf = true;
  while (true) {
    const information = await lstat(current);
    if (
      information.isSymbolicLink() ||
      (leaf && kind === 'file' ? !information.isFile() : !information.isDirectory())
    ) {
      reject('nonregular paths and ancestor links are forbidden');
    }
    identities.push({
      file: current,
      kind: leaf ? kind : 'directory',
      device: information.dev,
      inode: information.ino,
    });
    const parent = path.dirname(current);
    if (parent === current) {
      return identities;
    }
    current = parent;
    leaf = false;
  }
}

// Portable Node has no directory-relative open/link: identity rechecks detect drift, but cannot
// guarantee containment against concurrent same-user ancestor replacement between syscalls.
async function assertPathBinding(binding: PathIdentity[]): Promise<void> {
  const leaf = binding[0];
  if (!leaf) {
    reject('filesystem path binding is missing');
  }
  const current = await regularPath(leaf.file, leaf.kind);
  if (
    current.length !== binding.length ||
    binding.some(
      (identity, index) =>
        current[index]?.device !== identity.device || current[index]?.inode !== identity.inode,
    )
  ) {
    reject('filesystem path binding changed');
  }
}

async function withRegularFile<T>(
  file: string,
  read: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  const binding = await regularPath(file, 'file');
  const handle = await open(file, 'r');
  try {
    const information = await handle.stat();
    const leaf = binding[0];
    if (
      !leaf ||
      !information.isFile() ||
      information.dev !== leaf.device ||
      information.ino !== leaf.inode
    ) {
      reject('opened file differs from its validated path');
    }
    await assertPathBinding(binding);
    const result = await read(handle);
    await assertPathBinding(binding);
    return result;
  } finally {
    await handle.close();
  }
}

async function readPrivateRecord(
  file: string,
  keys: string,
  schemaVersion = 1,
): Promise<Record<string, unknown>> {
  return withRegularFile(file, async (handle) => {
    const information = await handle.stat();
    if (!information.isFile() || information.size > maximumEventBytes) {
      reject('private binding exceeds its file bound');
    }
    const bytes = Buffer.alloc(maximumEventBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximumEventBytes) {
      reject('private binding exceeds its file bound');
    }
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as { schemaVersion?: unknown }).schemaVersion !== schemaVersion ||
      Object.keys(value).sort().join('\0') !== keys
    ) {
      reject('invalid private binding record');
    }
    return value as Record<string, unknown>;
  });
}

async function nativeSessionPersisted(owner: Writer): Promise<boolean> {
  await assertPathBinding(owner.nativeRootBinding);
  const file = path.resolve(owner.nativeRoot, owner.nativeSessionFile);
  await regularPath(path.dirname(file), 'directory');
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  await withRegularFile(file, async (handle) => {
    const bytes = Buffer.alloc(maximumEventBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(10);
    if (newline < 0 || newline > maximumEventBytes) {
      reject('native session header is missing or exceeds its bound');
    }
    const header: unknown = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
    if (
      !header ||
      typeof header !== 'object' ||
      Array.isArray(header) ||
      (header as { type?: unknown }).type !== 'session' ||
      (header as { version?: unknown }).version !== 3 ||
      (header as { id?: unknown }).id !== owner.nativeSessionId ||
      typeof (header as { cwd?: unknown }).cwd !== 'string' ||
      !samePath((header as { cwd: string }).cwd, owner.cwd)
    ) {
      reject('native session header differs from the bound snapshot');
    }
  });
  await assertPathBinding(owner.nativeRootBinding);
  return true;
}

async function processFingerprint(pi: ExtensionAPI): Promise<string> {
  const result = await pi.exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}').CreationDate.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")`,
    ],
    { timeout: 5_000 },
  );
  const fingerprint = result.stdout.trim();
  if (
    result.code !== 0 ||
    result.killed ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(fingerprint) ||
    !Number.isFinite(Date.parse(fingerprint)) ||
    new Date(fingerprint).toISOString() !== fingerprint
  ) {
    reject('process birth verification failed');
  }
  return fingerprint;
}

function serializeEvent(event: SessionLifecycleEvent): string {
  const content = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(content) > maximumEventBytes) {
    reject('event exceeds its file bound');
  }
  return content;
}

async function publish(
  directory: string,
  binding: PathIdentity[],
  event: SessionLifecycleEvent,
): Promise<void> {
  const content = serializeEvent(event);
  await assertPathBinding(binding);
  if (
    (await readdir(directory)).filter((name) => name.endsWith('.json')).length >=
    maximumPendingEvents
  ) {
    reject('pending event limit reached');
  }
  const name = `${String(event.sequence).padStart(16, '0')}-${event.eventId}.json`;
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    let temporaryBinding: PathIdentity;
    try {
      await assertPathBinding(binding);
      const information = await handle.stat();
      temporaryBinding = {
        file: temporary,
        kind: 'file',
        device: information.dev,
        inode: information.ino,
      };
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertPathBinding([temporaryBinding, ...binding]);
    // Hard-link publication is atomic and, unlike rename, never replaces an existing event.
    await link(temporary, path.join(directory, name));
  } finally {
    // A failed cleanup must not turn a published event into a retry or follow a replaced directory.
    await assertPathBinding(binding)
      .then(() => rm(temporary, { force: true }))
      .catch(() => {});
  }
}

export default function sessionLifecycle(
  pi: ExtensionAPI,
  environment: Environment = process.env,
): void {
  const bindingId = environment.MPX_SESSION_LIFECYCLE_BINDING_ID;
  const configuredDirectory = environment.MPX_SESSION_LIFECYCLE_EVENT_DIR;
  if (bindingId === undefined && configuredDirectory === undefined) {
    return;
  }
  // Throw from a session hook so RPC and TUI both expose the startup diagnostic.
  const configuration = () => {
    if (
      !bindingId ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(bindingId) ||
      !configuredDirectory ||
      !path.isAbsolute(configuredDirectory) ||
      environment.MPX_RUNTIME !== 'pi' ||
      !environment.PI_CODING_AGENT_DIR ||
      !path.isAbsolute(environment.PI_CODING_AGENT_DIR) ||
      !environment.MPX_RUNTIME_CONTEXT
    ) {
      reject('invalid launch environment');
    }
    const directory = path.resolve(configuredDirectory);
    const encodedBinding = Buffer.from(bindingId, 'utf8').toString('base64url');
    const privateDirectory = path.dirname(path.dirname(directory));
    if (
      path.basename(directory) !== encodedBinding ||
      path.basename(path.dirname(directory)) !== 'lifecycle-events' ||
      path.basename(privateDirectory) !== 'private' ||
      path.basename(path.dirname(privateDirectory)) !== SESSION_STORE_VERSION ||
      path.basename(path.dirname(path.dirname(privateDirectory))) !== 'sessions' ||
      configuredDirectory.replaceAll('\\', '/') !== directory.replaceAll('\\', '/')
    ) {
      reject('event directory is not the bound private session store path');
    }
    return {
      bindingId,
      directory,
      bindingFile: path.join(privateDirectory, 'lifecycle-bindings', `${encodedBinding}.json`),
      nativeRoot: path.resolve(environment.PI_CODING_AGENT_DIR),
      context: parseRuntimeContext(JSON.parse(environment.MPX_RUNTIME_CONTEXT)),
    };
  };
  let writer: Writer | undefined;
  let closing = false;
  let configurationValue: ReturnType<typeof configuration> | undefined;

  function nativeSessionFile(context: ExtensionContext): string {
    const file = context.sessionManager.getSessionFile();
    if (!file) {
      reject('a persisted native session path is required');
    }
    const resolved = path.resolve(context.cwd, file);
    // Native replacement may leave the launch root, but malformed references still fail validation.
    parseNativeSessionRef({
      kind: 'root-relative-file',
      value: path.relative(path.parse(resolved).root, resolved).replaceAll('\\', '/'),
    });
    return resolved;
  }

  function snapshot(context: ExtensionContext): Snapshot {
    const file = nativeSessionFile(context);
    if (!configurationValue) {
      return reject('launch configuration is missing');
    }
    const nativeSessionId = context.sessionManager.getSessionId();
    const header = context.sessionManager.getHeader();
    if (!header || header.id !== nativeSessionId || !samePath(header.cwd, context.cwd)) {
      reject('native session manager header does not match the session');
    }
    return {
      nativeSessionId,
      nativeSessionRef: parseNativeSessionRef({
        kind: 'root-relative-file',
        value: path.relative(configurationValue.nativeRoot, file).replaceAll('\\', '/'),
      }),
      cwd: context.cwd,
      title: pi.getSessionName() || null,
      model: context.model ? `${context.model.provider}/${context.model.id}` : null,
      effort: context.thinkingLevel ?? null,
    };
  }

  async function flushPending(owner: Writer): Promise<void> {
    if (!configurationValue || !(await nativeSessionPersisted(owner))) {
      return;
    }
    await assertPathBinding(owner.directoryBinding);
    while (owner.pending.length > 0) {
      const pending = owner.pending[0];
      if (pending) {
        await publish(configurationValue.directory, owner.directoryBinding, pending);
        owner.pending.shift();
      }
    }
  }

  function enqueue(type: SessionLifecycleEvent['type'], snapshotValue?: Snapshot): Promise<void> {
    if (!writer || !configurationValue) {
      return Promise.resolve();
    }
    const owner = writer;
    const { bindingId, nativeRoot } = configurationValue;
    const operation = owner.queue.then(async () => {
      const current = snapshotValue ?? owner.snapshot;
      if (
        !samePath(nativeRoot, owner.nativeRoot) ||
        current.nativeSessionId !== owner.nativeSessionId ||
        current.nativeSessionRef.value !== owner.nativeSessionFile ||
        !samePath(current.cwd, owner.cwd)
      ) {
        reject('launch binding cannot own a replacement session');
      }
      const timestamp = new Date(Math.max(Date.now(), Date.parse(owner.timestamp))).toISOString();
      const event = createSessionLifecycleEvent({
        ...current,
        eventId: randomUUID(),
        bindingId,
        type,
        sequence: owner.sequence + 1,
        timestamp,
        pid: process.pid,
        startFingerprint: owner.startFingerprint,
      });
      serializeEvent(event);
      if (owner.pending.length >= maximumPendingEvents) {
        await flushPending(owner);
        if (owner.pending.length >= maximumPendingEvents) {
          reject('pending event limit reached');
        }
      }
      owner.snapshot = current;
      owner.pending.push(event);
      owner.sequence = event.sequence;
      owner.timestamp = timestamp;
      await flushPending(owner);
    });
    // Rejection belongs to this hook; the ordering tail must still admit recovery hooks.
    owner.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  pi.on('session_start', async (event, context) => {
    configurationValue = configuration();
    const { bindingId, directory, bindingFile, nativeRoot } = configurationValue;
    const writers = (processState[writerKey] ??= new Map());
    const previous = writers.get(directory);
    if (previous) {
      if (!samePath(previous.nativeRoot, nativeRoot)) {
        reject('native root differs from the original writer');
      }
      if (previous.retired) {
        writer = undefined;
        return;
      }
      const file = nativeSessionFile(context);
      const sameSession =
        context.sessionManager.getSessionId() === previous.nativeSessionId &&
        samePath(file, path.resolve(previous.nativeRoot, previous.nativeSessionFile));
      if (
        !previous.active &&
        !sameSession &&
        (event.reason === 'new' || event.reason === 'resume' || event.reason === 'fork')
      ) {
        await previous.queue;
        previous.retired = true;
        writer = undefined;
        if (!previous.replacementWarned) {
          previous.replacementWarned = true;
          const warning =
            'This native replacement session is not MPX launch-bound. MPX lifecycle tracking has stopped; use a fresh MPX launch to track it.';
          if (context.hasUI) {
            context.ui.notify(warning, 'warning');
          } else {
            console.warn(warning);
          }
        }
        return;
      }
      if (event.reason !== 'reload' || previous.active || !sameSession) {
        reject('launch binding already has a native session writer');
      }
    }
    const directoryBinding = await regularPath(directory, 'directory');
    const nativeRootBinding = await regularPath(nativeRoot, 'directory');
    if (previous) {
      await assertPathBinding(previous.directoryBinding);
      await assertPathBinding(previous.nativeRootBinding);
    }
    const recorded = await readPrivateRecord(
      bindingFile,
      'binding\0launch\0location\0nativeBindingRef\0nativeSessionRef\0schemaVersion',
      2,
    );
    const binding = validateSessionLifecycleBinding({
      binding: recorded.binding,
      context: configurationValue.context,
      runtime: 'pi',
    });
    if (
      binding.bindingId !== bindingId ||
      binding.projectRef !== (configurationValue.context.binding.projectId ?? 'unbound') ||
      binding.repositoryRef !== configurationValue.context.binding.repositoryId ||
      !path.isAbsolute(binding.worktreeRef) ||
      !samePath(binding.worktreeRef, context.cwd)
    ) {
      reject('project or working directory differs from the launch binding');
    }
    if (typeof recorded.nativeBindingRef !== 'string' || !recorded.nativeBindingRef) {
      reject('invalid native binding reference');
    }
    const nativeBinding = await readPrivateRecord(
      path.join(
        path.dirname(path.dirname(bindingFile)),
        'native-bindings',
        `${Buffer.from(recorded.nativeBindingRef, 'utf8').toString('base64url')}.json`,
      ),
      'createdAt\0identity\0recordedRootDigest\0ref\0runtime\0schemaVersion\0updatedAt',
    );
    const normalizedRoot = (
      path.win32.isAbsolute(nativeRoot)
        ? path.win32.normalize(nativeRoot).replaceAll('\\', '/').toLowerCase()
        : path.posix.normalize(nativeRoot)
    ).replace(/\/$/u, '');
    const rootDigest = createHash('sha256').update(JSON.stringify(normalizedRoot)).digest('hex');
    const identity = nativeBinding.identity as { domain?: unknown; name?: unknown } | null;
    if (
      nativeBinding.ref !== recorded.nativeBindingRef ||
      nativeBinding.runtime !== 'pi' ||
      nativeBinding.recordedRootDigest !== rootDigest ||
      !identity ||
      typeof identity.domain !== 'string' ||
      typeof identity.name !== 'string' ||
      `${identity.domain}:${identity.name}` !== binding.identityRef
    ) {
      reject('native root or identity differs from the private launch binding');
    }
    const current = snapshot(context);
    if (recorded.nativeSessionRef !== null) {
      const reference = parseNativeSessionRef(recorded.nativeSessionRef);
      if (
        reference.kind !== current.nativeSessionRef.kind ||
        reference.value !== current.nativeSessionRef.value
      ) {
        reject('native session differs from the prepared resume target');
      }
    }
    if (previous) {
      writer = previous;
    } else {
      if (event.reason !== 'startup') {
        reject('replacement sessions require a fresh launch binding');
      }
      const startFingerprint = await processFingerprint(pi);
      await assertPathBinding(directoryBinding);
      await assertPathBinding(nativeRootBinding);
      const receipt = createSessionLifecycleEvent({
        ...current,
        eventId: randomUUID(),
        bindingId,
        type: 'start',
        sequence: 1,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        startFingerprint,
      });
      const receiptContent = serializeEvent(receipt);
      // An exclusive receipt prevents inherited launch environments from acquiring a second writer.
      const claim = await open(path.join(directory, '.writer'), 'wx', 0o600);
      try {
        await assertPathBinding(directoryBinding);
        await claim.writeFile(receiptContent);
        await claim.sync();
      } finally {
        await claim.close();
      }
      writer = {
        queue: Promise.resolve(),
        directoryBinding,
        nativeRootBinding,
        sequence: 0,
        timestamp: new Date().toISOString(),
        nativeSessionId: current.nativeSessionId,
        nativeSessionFile: current.nativeSessionRef.value,
        cwd: current.cwd,
        startFingerprint,
        snapshot: current,
        nativeRoot,
        active: false,
        retired: false,
        replacementWarned: false,
        pending: [],
      };
      writers.set(directory, writer);
    }
    const activeWriter = writer;
    if (!activeWriter) {
      reject('native session writer was not initialized');
    }
    activeWriter.active = true;
    closing = false;
    await enqueue('start', current);
  });

  const update = (type: 'info' | 'activity', context: ExtensionContext) =>
    writer?.active && !closing ? enqueue(type, snapshot(context)) : Promise.resolve();
  pi.on('session_info_changed', (_event, context) => update('info', context));
  pi.on('model_select', (_event, context) => update('info', context));
  pi.on('thinking_level_select', (_event, context) => update('info', context));
  pi.on('agent_start', (_event, context) => update('activity', context));
  pi.on('turn_end', (_event, context) => update('activity', context));
  pi.on('agent_settled', (_event, context) => update('activity', context));
  pi.on('session_shutdown', async (event) => {
    if (!writer?.active || closing) {
      return;
    }
    const owner = writer;
    closing = true;
    try {
      // Reload tears down only this extension instance; the native session and OS process remain.
      // Replacement and quit flows close the old native session even though Pi may keep its process.
      if (event.reason !== 'reload') {
        await enqueue('shutdown');
      } else {
        await owner.queue;
        await flushPending(owner);
      }
    } finally {
      owner.active = false;
    }
  });
}
