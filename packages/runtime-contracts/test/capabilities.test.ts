import { describe, expect, it } from "vitest";
import {
  createRuntimeCapabilityManifestV1,
  createToolRequestEnvelopeV1,
  createToolResultEnvelopeV1,
  createToolErrorEnvelopeV1,
  deriveChildAuthority,
  validateRuntimeCapabilityBinding,
  validateToolCallV1,
  validateToolResultV1,
  type ChildLaunchRequestV1,
  type RuntimeCapabilityManifestV1,
} from "../src/index.js";

const digest = (character: string) => character.repeat(64);
const tool = {
  name: "search", executors: ["docker" as const], routes: ["mcp:search"],
  network: { mode: "allow-list" as const, destinations: ["api.example.test"] },
  paidCredits: { allowed: true, maxCredits: 5 }, input: { maxBytes: 128 }, output: { maxBytes: 64 },
  timeout: { maxMs: 1_000 }, cache: { mode: "read-only" as const, maxBytes: 32 },
};
function manifest(): RuntimeCapabilityManifestV1 {
  return createRuntimeCapabilityManifestV1({
    runtime: "claude", launchKey: digest("a"), identity: { name: "personal", domain: "personal", nativeRuntimeRootDigest: digest("b") },
    binding: { projectId: "p", repositoryId: "r", contentScope: "personal" }, executor: "docker", tools: [tool],
    routes: ["mcp:search", "git:personal"], resources: ["project", "tmp"], mounts: ["project:rw", "tmp:rw"],
    destinations: ["api.example.test", "cache.example.test"], skills: ["review", "test"], models: ["model-a", "model-b"], nesting: { depth: 0, maxDepth: 2 },
  });
}
function childRequest(parent = manifest()): ChildLaunchRequestV1 {
  return {
    schemaVersion: 1, parentManifestKey: parent.manifestKey, parentLaunchKey: parent.launchKey, runtime: parent.runtime,
    identity: parent.identity, binding: parent.binding, executor: parent.executor, tools: ["search"], routes: ["mcp:search"],
    resources: ["project"], mounts: ["project:rw"], destinations: ["api.example.test"], skills: ["review"], models: ["model-a"],
    nesting: { depth: 1, maxDepth: 1 },
  };
}

describe("runtime capability contracts", () => {
  it("creates provider-neutral deterministic manifests independent of input ordering", () => {
    const first = manifest();
    const second = createRuntimeCapabilityManifestV1({ ...first, tools: [...first.tools], routes: [...first.routes].reverse(), resources: [...first.resources].reverse(), mounts: [...first.mounts].reverse(), destinations: [...first.destinations].reverse(), skills: [...first.skills].reverse(), models: [...first.models].reverse() });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/github|gitlab|provider/u);
  });

  it("rejects malformed capability input", () => {
    expect(() => createRuntimeCapabilityManifestV1({ ...manifest(), routes: ["bad route"] })).toThrowError(/INVALID_CAPABILITY/u);
  });

  it("validates immutable bindings at start time", () => {
    const value = manifest();
    expect(validateRuntimeCapabilityBinding(value, { manifestKey: value.manifestKey, launchKey: value.launchKey, runtime: value.runtime, identity: value.identity, binding: value.binding, executor: value.executor })).toEqual(value);
    expect(() => validateRuntimeCapabilityBinding(value, { manifestKey: value.manifestKey, launchKey: digest("c"), runtime: value.runtime, identity: value.identity, binding: value.binding, executor: value.executor })).toThrowError(/CAPABILITY_STALE/u);
  });

  it("enforces every per-tool policy at call admission", () => {
    const value = manifest();
    const base = { manifestKey: value.manifestKey, launchKey: value.launchKey, tool: "search", executor: "docker" as const, route: "mcp:search", destination: "api.example.test", paidCredits: 5, timeoutMs: 1_000, cacheMode: "read-only" as const, input: { q: "ok" } };
    expect(validateToolCallV1(value, createToolRequestEnvelopeV1(base))).toMatchObject({ tool: "search" });
    for (const change of [
      { executor: "host" }, { route: "mcp:borrowed" }, { destination: "other.test" }, { paidCredits: 6 },
      { timeoutMs: 1_001 }, { cacheMode: "read-write" }, { input: { q: "x".repeat(200) } },
    ]) expect(() => validateToolCallV1(value, createToolRequestEnvelopeV1({ ...base, ...change } as typeof base))).toThrowError(/TOOL_AUTHORITY_DENIED|ENVELOPE_LIMIT/u);
  });

  it("bounds result and error envelopes", () => {
    const request = createToolRequestEnvelopeV1({ manifestKey: manifest().manifestKey, launchKey: manifest().launchKey, tool: "search", executor: "docker", route: "mcp:search", destination: "api.example.test", paidCredits: 0, timeoutMs: 10, cacheMode: "disabled", input: null });
    expect(() => createToolResultEnvelopeV1({ requestKey: request.requestKey, output: "x".repeat(65), maxOutputBytes: 64 })).toThrowError(/ENVELOPE_LIMIT/u);
    expect(() => createToolErrorEnvelopeV1({ requestKey: request.requestKey, code: "BAD", message: "x".repeat(257) })).toThrowError(/ENVELOPE_LIMIT/u);
  });

  it("enforces the authorized tool output bound per call", () => {
    const value = manifest();
    const request = createToolRequestEnvelopeV1({ manifestKey: value.manifestKey, launchKey: value.launchKey, tool: "search", executor: "docker", route: "mcp:search", destination: "api.example.test", paidCredits: 0, timeoutMs: 10, cacheMode: "disabled", input: null });
    const result = createToolResultEnvelopeV1({ requestKey: request.requestKey, output: "x".repeat(64), maxOutputBytes: 1_000 });
    expect(() => validateToolResultV1(value, request, result)).toThrowError(/ENVELOPE_LIMIT/u);
  });
});

describe("child launch authority", () => {
  it("derives deterministic child keys bound to the complete narrowed authority", () => {
    expect(deriveChildAuthority(manifest(), childRequest())).toEqual(deriveChildAuthority(manifest(), childRequest()));
    expect(deriveChildAuthority(manifest(), childRequest()).childKey).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(["tools", "routes", "resources", "mounts", "destinations", "skills", "models"] as const)("rejects widening the %s axis", (axis) => {
    const request = childRequest();
    expect(() => deriveChildAuthority(manifest(), { ...request, [axis]: [...request[axis], `borrowed-${axis}`] })).toThrowError(/CHILD_AUTHORITY_WIDENING/u);
  });

  it("rejects nesting widening", () => {
    expect(() => deriveChildAuthority(manifest(), { ...childRequest(), nesting: { depth: 1, maxDepth: 3 } })).toThrowError(/CHILD_AUTHORITY_WIDENING/u);
  });

  it("rejects stale parent authority", () => {
    expect(() => deriveChildAuthority(manifest(), { ...childRequest(), parentManifestKey: digest("c") })).toThrowError(/PARENT_AUTHORITY_STALE/u);
  });

  it("rejects cross-identity and root-digest changes", () => {
    expect(() => deriveChildAuthority(manifest(), { ...childRequest(), identity: { ...childRequest().identity, name: "work" } })).toThrowError(/CHILD_BINDING_MISMATCH/u);
    expect(() => deriveChildAuthority(manifest(), { ...childRequest(), identity: { ...childRequest().identity, nativeRuntimeRootDigest: digest("c") } })).toThrowError(/CHILD_BINDING_MISMATCH/u);
  });

  it("rejects route borrowing even when the tool exists", () => {
    expect(() => deriveChildAuthority(manifest(), { ...childRequest(), routes: ["git:other"] })).toThrowError(/CHILD_AUTHORITY_WIDENING/u);
  });

  it("rejects Docker-to-host fallback", () => {
    expect(() => deriveChildAuthority(manifest(), { ...childRequest(), executor: "host" })).toThrowError(/CHILD_BINDING_MISMATCH/u);
  });

  it("rejects malformed child input", () => {
    expect(() => deriveChildAuthority(manifest(), { ...childRequest(), tools: [""] })).toThrowError(/INVALID_CAPABILITY/u);
  });
});
