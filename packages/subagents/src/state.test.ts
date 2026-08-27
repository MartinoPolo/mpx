import { describe, expect, it } from "vitest";
import { PrivateMemoryStore, resolvePrivateStatePath, TranscriptStore } from "./state.js";

describe("private subagent state", () => {
  it("partitions memory by launch identity", () => { const store = new PrivateMemoryStore(); store.write({ identity: "personal", scope: "user", agent: "reviewer", key: "notes", value: "private" }); expect(store.read({ identity: "work", scope: "user", agent: "reviewer", key: "notes" })).toBeUndefined(); });
  it("bounds transcript retention", () => { const store = new TranscriptStore(2, 10_000); for (let at = 1; at <= 3; at++) store.append("personal", "a", { at, role: "assistant", text: String(at) }); expect(store.read("personal", "a").map(entry => entry.text)).toEqual(["2", "3"]); });
  it("rejects symlink and path replacement", async () => { await expect(resolvePrivateStatePath({ resolvePrivate: async identity => ({ path: "C:/private path", identity, replaced: true, symlink: false }) }, "personal", ["agent", "memory"])).rejects.toThrow(/SUBAGENT_STATE_PATH_UNSAFE/); });
  it("rejects private state resolved for the opposite identity", async () => { await expect(resolvePrivateStatePath({ resolvePrivate: async () => ({ path: "C:/private", identity: "work", replaced: false, symlink: false }) }, "personal", ["agent"])).rejects.toThrow(/SUBAGENT_IDENTITY_MISMATCH/); });
});
