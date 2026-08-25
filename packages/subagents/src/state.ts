import { MpxError } from "@mpx/core";
import type { MemoryScope } from "./contracts.js";

function fail(code: string, message: string): never { throw new MpxError({ code, message: `${code}: ${message}`, retryable: false }); }
function label(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) fail("SUBAGENT_STATE_KEY_INVALID", `${field} is not a safe opaque label.`);
  return value;
}
function partition(identity: string, scope: MemoryScope, projectId?: string): string {
  const id = label(identity, "identity");
  if (scope !== "user" && !projectId) fail("SUBAGENT_PROJECT_REQUIRED", `${scope} memory requires a project id.`);
  return `${id}/${scope}/${scope === "user" ? "_" : label(projectId!, "project")}`;
}

/** Identity-partitioned private memory; callers can never name filesystem paths. */
export class PrivateMemoryStore {
  private readonly values = new Map<string, Map<string, string>>();
  read(input: { identity: string; scope: MemoryScope; projectId?: string; agent: string; key: string }): string | undefined {
    return this.values.get(partition(input.identity, input.scope, input.projectId))?.get(`${label(input.agent, "agent")}/${label(input.key, "key")}`);
  }
  write(input: { identity: string; scope: MemoryScope; projectId?: string; agent: string; key: string; value: string }): void {
    const owner = partition(input.identity, input.scope, input.projectId);
    const bucket = this.values.get(owner) ?? new Map<string, string>();
    bucket.set(`${label(input.agent, "agent")}/${label(input.key, "key")}`, input.value);
    this.values.set(owner, bucket);
  }
}

export interface TranscriptEntry { readonly at: number; readonly role: "user" | "assistant" | "tool"; readonly text: string }
/** Bounded per-agent transcripts with deterministic oldest-first eviction. */
export class TranscriptStore {
  private readonly values = new Map<string, TranscriptEntry[]>();
  constructor(private readonly maxEntries = 200, private readonly maxBytes = 256 * 1024) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("SUBAGENT_TRANSCRIPT_BOUND_INVALID", "Transcript bounds must be positive safe integers.");
  }
  append(identity: string, agentId: string, entry: TranscriptEntry): void {
    const key = `${label(identity, "identity")}/${label(agentId, "agent")}`;
    const entries = [...(this.values.get(key) ?? []), Object.freeze({ ...entry })];
    while (entries.length > this.maxEntries || Buffer.byteLength(JSON.stringify(entries), "utf8") > this.maxBytes) entries.shift();
    this.values.set(key, entries);
  }
  read(identity: string, agentId: string): readonly TranscriptEntry[] { return Object.freeze([...(this.values.get(`${label(identity, "identity")}/${label(agentId, "agent")}`) ?? [])]); }
  retainSince(cutoff: number): void {
    for (const [key, entries] of this.values) {
      const retained = entries.filter(entry => entry.at >= cutoff);
      if (retained.length) this.values.set(key, retained); else this.values.delete(key);
    }
  }
}

export interface SafePrivatePathAdapter {
  resolvePrivate(identity: string, segments: readonly string[]): Promise<{ path: string; identity: string; replaced: boolean; symlink: boolean }>;
}
export async function resolvePrivateStatePath(adapter: SafePrivatePathAdapter, identity: string, segments: readonly string[]): Promise<string> {
  const safe = segments.map((segment) => label(segment, "path segment"));
  const resolved = await adapter.resolvePrivate(label(identity, "identity"), safe);
  if (resolved.identity !== identity) fail("SUBAGENT_IDENTITY_MISMATCH", "Private state belongs to the opposite identity.");
  if (resolved.symlink || resolved.replaced) fail("SUBAGENT_STATE_PATH_UNSAFE", "Symlinked or replaced private state paths are refused.");
  return resolved.path;
}
