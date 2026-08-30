import { createHash } from "node:crypto";
import { MpxError } from "@mpx/core";

const BEGIN = "# >>> MPX MANAGED LAUNCHERS >>>";
const END = "# <<< MPX MANAGED LAUNCHERS <<<";
const RELEASE_CLI_PATH = /[\\/]mpx[\\/]releases[\\/][a-f0-9]{64}[\\/]bin[\\/]mpx\.mjs$/iu;
const ABSOLUTE_WINDOWS_EXECUTABLE = /^[A-Za-z]:[\\/].+\.exe$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(code: string, message: string): never { throw new MpxError({ code, message }); }
function digest(value: Uint8Array | unknown): string {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(canonicalJson(value));
  return createHash("sha256").update(bytes).digest("hex");
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function clone<T>(value: T): T { return structuredClone(value); }

export interface BinaryFileSystem {
  read(path: string): Promise<Buffer | undefined>;
  /** Atomically creates an absent file. Returns false without mutation when the target already exists. */
  create(path: string, body: Buffer): Promise<boolean>;
  write(path: string, body: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
}
export class FakeBinaryFileSystem implements BinaryFileSystem {
  private readonly files = new Map<string, Buffer>();
  constructor(initial: Readonly<Record<string, Buffer>> = {}) { for (const [key, value] of Object.entries(initial)) this.files.set(key, Buffer.from(value)); }
  async read(target: string) { const value = this.files.get(target); return value && Buffer.from(value); }
  async create(target: string, body: Buffer) { if (this.files.has(target)) return false; this.files.set(target, Buffer.from(body)); return true; }
  async write(target: string, body: Buffer) { this.files.set(target, Buffer.from(body)); }
  async remove(target: string) { this.files.delete(target); }
}

export interface ManagedLauncherSpec { readonly shell: "bash" | "powershell"; readonly path: string; readonly body: string }
export interface ManagedLauncherInspection { readonly schemaVersion: 1; readonly kind: "managed-launcher-inspection"; readonly target: string; readonly status: "absent" | "present"; readonly digest: string | null }
export interface ManagedLauncherPlan { readonly schemaVersion: 1; readonly kind: "managed-launcher-plan"; readonly spec: ManagedLauncherSpec; readonly observedDigest: string | null; readonly outputBase64: string; readonly managedBase64: string; readonly previousManagedBase64: string | null }
export interface ManagedLauncherReceipt { readonly schemaVersion: 1; readonly kind: "managed-launcher-receipt"; readonly target: string; readonly shell: "bash" | "powershell"; readonly managedBase64: string; readonly previousManagedBase64: string | null }

interface BlockRange { start: number; end: number; bytes: Buffer }
function count(haystack: string, needle: string): number { return haystack.split(needle).length - 1; }
function locate(body: Buffer): BlockRange | undefined {
  const text = body.toString("utf8"), begins = count(text, BEGIN), ends = count(text, END);
  if (begins !== ends || begins > 1) fail("WINDOWS_MANAGED_BLOCK_MALFORMED", "Managed launcher markers are malformed or duplicated.");
  if (begins === 0) return undefined;
  const startChars = text.indexOf(BEGIN), endMarkerChars = text.indexOf(END, startChars + BEGIN.length);
  if (endMarkerChars < startChars) fail("WINDOWS_MANAGED_BLOCK_MALFORMED", "Managed launcher markers are out of order.");
  let endChars = endMarkerChars + END.length;
  if (text.slice(endChars, endChars + 2) === "\r\n") endChars += 2; else if (text[endChars] === "\n") endChars += 1;
  const start = Buffer.byteLength(text.slice(0, startChars)), end = Buffer.byteLength(text.slice(0, endChars));
  return { start, end, bytes: body.subarray(start, end) };
}
function newlineFor(body: Buffer): "\r\n" | "\n" { return body.includes(Buffer.from("\r\n")) ? "\r\n" : "\n"; }
function managedBytes(spec: ManagedLauncherSpec, newline: string): Buffer {
  if (!spec.path || spec.body.includes(BEGIN) || spec.body.includes(END) || spec.body.includes("\0")) fail("WINDOWS_MANAGED_BLOCK_INVALID", "Managed launcher specification is invalid.");
  const normalized = spec.body.replace(/\r?\n/gu, newline).replace(new RegExp(`${newline}$`, "u"), "");
  return Buffer.from(`${BEGIN}${newline}${normalized}${newline}${END}${newline}`, "utf8");
}
export class ManagedLauncherAdapter {
  constructor(private readonly files: BinaryFileSystem) {}
  async inspect(spec: ManagedLauncherSpec): Promise<ManagedLauncherInspection> {
    const current = await this.files.read(spec.path), block = current && locate(current);
    return { schemaVersion: 1, kind: "managed-launcher-inspection", target: spec.path, status: block ? "present" : "absent", digest: block ? digest(block.bytes) : null };
  }
  async plan(spec: ManagedLauncherSpec): Promise<ManagedLauncherPlan> {
    const current = await this.files.read(spec.path) ?? Buffer.alloc(0), block = locate(current), managed = managedBytes(spec, newlineFor(current));
    let output: Buffer;
    if (block) output = Buffer.concat([current.subarray(0, block.start), managed, current.subarray(block.end)]);
    else {
      const separator = current.length > 0 && !current.subarray(-1).equals(Buffer.from("\n")) ? Buffer.from(newlineFor(current)) : Buffer.alloc(0);
      output = Buffer.concat([current, separator, managed]);
    }
    return { schemaVersion: 1, kind: "managed-launcher-plan", spec: clone(spec), observedDigest: current.length ? digest(current) : null, outputBase64: output.toString("base64"), managedBase64: managed.toString("base64"), previousManagedBase64: block?.bytes.toString("base64") ?? null };
  }
  async apply(plan: ManagedLauncherPlan): Promise<ManagedLauncherReceipt> {
    const current = await this.files.read(plan.spec.path) ?? Buffer.alloc(0), actual = current.length ? digest(current) : null;
    if (actual !== plan.observedDigest) fail("WINDOWS_OBSERVATION_CHANGED", "Launcher profile changed after planning.");
    await this.files.write(plan.spec.path, Buffer.from(plan.outputBase64, "base64"));
    return { schemaVersion: 1, kind: "managed-launcher-receipt", target: plan.spec.path, shell: plan.spec.shell, managedBase64: plan.managedBase64, previousManagedBase64: plan.previousManagedBase64 };
  }
  async remove(receipt: ManagedLauncherReceipt): Promise<void> {
    const current = await this.files.read(receipt.target); if (!current) fail("WINDOWS_OWNED_RESOURCE_DRIFT", "Owned launcher profile is missing.");
    const block = locate(current), owned = Buffer.from(receipt.managedBase64, "base64");
    if (!block || !block.bytes.equals(owned)) fail("WINDOWS_OWNED_RESOURCE_DRIFT", "Owned launcher block has drifted.");
    const replacement = receipt.previousManagedBase64 ? Buffer.from(receipt.previousManagedBase64, "base64") : Buffer.alloc(0);
    const output = Buffer.concat([current.subarray(0, block.start), replacement, current.subarray(block.end)]);
    if (output.length) await this.files.write(receipt.target, output); else await this.files.remove(receipt.target);
  }
}

export type OwnedResourceKind = "terminal-profile" | "user-environment" | "shortcut" | "scheduled-task";
export interface OwnedResourceSpec { readonly kind: OwnedResourceKind; readonly target: string; readonly ownershipKey: string; readonly desired: Readonly<Record<string, unknown>> }
export interface OwnedResourceInspection { readonly schemaVersion: 1; readonly kind: "owned-resource-inspection"; readonly target: string; readonly status: "absent" | "owned" | "foreign"; readonly digest: string | null; readonly value?: unknown }
export interface OwnedResourcePlan { readonly schemaVersion: 1; readonly kind: "owned-resource-plan"; readonly spec: OwnedResourceSpec; readonly inspection: OwnedResourceInspection }
export interface OwnedResourceReceipt { readonly schemaVersion: 1; readonly kind: "owned-resource-receipt"; readonly spec: OwnedResourceSpec; readonly desiredDigest: string }
export interface JsonResourceStore { read(target: string): Promise<unknown | undefined>; write(target: string, value: unknown): Promise<void>; remove(target: string): Promise<void> }
export class FakeJsonResourceStore implements JsonResourceStore {
  private readonly values = new Map<string, unknown>();
  constructor(initial: Readonly<Record<string, unknown>> = {}) { for (const [key, value] of Object.entries(initial)) this.values.set(key, clone(value)); }
  async read(target: string) { const value = this.values.get(target); return value === undefined ? undefined : clone(value); }
  async write(target: string, value: unknown) { this.values.set(target, clone(value)); }
  async remove(target: string) { this.values.delete(target); }
}
/** Explicit capability fakes used by clean/existing-machine simulations. */
export class FakeRegistryStore extends FakeJsonResourceStore {}
export class FakeTerminalStore extends FakeJsonResourceStore {}
export class FakeShortcutStore extends FakeJsonResourceStore {}
export class FakeScheduledTaskStore extends FakeJsonResourceStore {}
function terminalProfiles(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profiles = (value as { profiles?: unknown }).profiles;
  return Array.isArray(profiles) ? profiles : undefined;
}
function terminalOwned(spec: OwnedResourceSpec, current: unknown): unknown | undefined {
  return terminalProfiles(current)?.find((profile) => profile && typeof profile === "object" && (profile as { guid?: unknown }).guid === spec.ownershipKey);
}
function environmentOwned(spec: OwnedResourceSpec, current: unknown): unknown | undefined {
  if (!current || typeof current !== "object" || Array.isArray(current)) return current === undefined ? undefined : current;
  const record = current as Record<string, unknown>;
  if (record.owner === undefined) return undefined;
  if (record.owner !== spec.desired.owner) return current;
  return Object.fromEntries(Object.keys(spec.desired).map((key) => [key, record[key]]));
}
function validateResource(spec: OwnedResourceSpec): void {
  if (!spec.target || !spec.ownershipKey || !spec.desired || typeof spec.desired !== "object") fail("WINDOWS_RESOURCE_INVALID", "System resource specification is invalid.");
}
function validateDesired(spec: OwnedResourceSpec): void {
  if (spec.kind === "scheduled-task") {
    const executable = spec.desired.executable, argv = spec.desired.argv;
    if (typeof executable !== "string" || !ABSOLUTE_WINDOWS_EXECUTABLE.test(executable) || !Array.isArray(argv) || typeof argv[0] !== "string" || !RELEASE_CLI_PATH.test(argv[0]) || argv.some((x) => typeof x !== "string") || typeof spec.desired.executableSha256 !== "string" || !SHA256.test(spec.desired.executableSha256) || typeof spec.desired.cliSha256 !== "string" || !SHA256.test(spec.desired.cliSha256)) fail("WINDOWS_TASK_RUNNER_MUTABLE", "Scheduled task must invoke verified Node with a receipt-bound immutable CLI bundle.");
  }
}
export class OwnedJsonResourceAdapter {
  constructor(private readonly store: JsonResourceStore) {}
  async inspect(spec: OwnedResourceSpec): Promise<OwnedResourceInspection> {
    validateResource(spec); const current = await this.store.read(spec.target);
    const value = spec.kind === "terminal-profile" ? terminalOwned(spec, current) : spec.kind === "user-environment" ? environmentOwned(spec, current) : current;
    if (value === undefined) { validateDesired(spec); return { schemaVersion: 1, kind: "owned-resource-inspection", target: spec.target, status: "absent", digest: null }; }
    const owned = canonicalJson(value) === canonicalJson(spec.desired);
    if (owned) validateDesired(spec);
    return { schemaVersion: 1, kind: "owned-resource-inspection", target: spec.target, status: owned ? "owned" : "foreign", digest: digest(value), value };
  }
  async plan(spec: OwnedResourceSpec): Promise<OwnedResourcePlan> { return { schemaVersion: 1, kind: "owned-resource-plan", spec: clone(spec), inspection: await this.inspect(spec) }; }
  async apply(plan: OwnedResourcePlan): Promise<OwnedResourceReceipt> {
    const current = await this.inspect(plan.spec);
    if (canonicalJson(current) !== canonicalJson(plan.inspection)) fail("WINDOWS_OBSERVATION_CHANGED", "System resource changed after planning.");
    if (current.status === "foreign") fail("WINDOWS_FOREIGN_RESOURCE", "Refusing to overwrite a foreign system resource.");
    if (current.status === "absent") {
      if (plan.spec.kind === "terminal-profile") {
        const root = await this.store.read(plan.spec.target) ?? { profiles: [] }, profiles = terminalProfiles(root);
        if (!profiles) fail("WINDOWS_FOREIGN_RESOURCE", "Terminal settings have an unsupported shape.");
        await this.store.write(plan.spec.target, { ...(root as Record<string, unknown>), profiles: [...profiles, clone(plan.spec.desired)] });
      } else if (plan.spec.kind === "user-environment") {
        const root = await this.store.read(plan.spec.target) ?? {};
        if (!root || typeof root !== "object" || Array.isArray(root)) fail("WINDOWS_FOREIGN_RESOURCE", "User environment has an unsupported shape.");
        await this.store.write(plan.spec.target, { ...(root as Record<string, unknown>), ...clone(plan.spec.desired) });
      } else await this.store.write(plan.spec.target, plan.spec.desired);
    }
    return { schemaVersion: 1, kind: "owned-resource-receipt", spec: clone(plan.spec), desiredDigest: digest(plan.spec.desired) };
  }
  async remove(receipt: OwnedResourceReceipt): Promise<void> {
    const inspection = await this.inspect(receipt.spec);
    if (inspection.status !== "owned" || inspection.digest !== receipt.desiredDigest) fail("WINDOWS_OWNED_RESOURCE_DRIFT", "Refusing to remove a foreign or drifted system resource.");
    if (receipt.spec.kind === "terminal-profile") {
      const root = await this.store.read(receipt.spec.target) as Record<string, unknown>, profiles = terminalProfiles(root)!;
      await this.store.write(receipt.spec.target, { ...root, profiles: profiles.filter((x) => x && typeof x === "object" && (x as { guid?: unknown }).guid !== receipt.spec.ownershipKey) });
    } else if (receipt.spec.kind === "user-environment") {
      const root = { ...await this.store.read(receipt.spec.target) as Record<string, unknown> };
      for (const key of Object.keys(receipt.spec.desired)) delete root[key];
      if (Object.keys(root).length) await this.store.write(receipt.spec.target, root); else await this.store.remove(receipt.spec.target);
    } else await this.store.remove(receipt.spec.target);
  }
}

/** UUIDv5-style stable identifier reserved for MPX Terminal profiles. */
export function deterministicTerminalProfileGuid(name: string): string {
  const bytes = createHash("sha1").update(`mpx.windows-terminal:${name.normalize("NFC")}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex"); return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}
