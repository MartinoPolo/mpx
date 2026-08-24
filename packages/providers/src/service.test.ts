import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ProviderAdapterRegistry, ProviderRegistry, ProviderService,
  type IssueV1, type ProviderAdapter, type ProviderDescriptor,
} from "./index.js";

const registry = new ProviderRegistry();
const github = registry.get("github");
const githubIssueCapabilities = github.capabilities.filter(capability => capability.startsWith("issue."));
const issueAdapter = (overrides: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
  providerId: "github",
  role: "issues",
  backend: "gh",
  capabilities: githubIssueCapabilities,
  routeRequired: true,
  invoke: vi.fn(async request => ({ capability: request.capability })),
  ...overrides,
});
const kanbanFlowAdapter = (invoke: ProviderAdapter["invoke"]): ProviderAdapter => ({
  providerId: "kanbanflow",
  role: "issues",
  backend: "kf",
  capabilities: registry.get("kanbanflow").capabilities,
  routeRequired: true,
  invoke,
});

describe("adapter registry", () => {
  it.each([
    ["duplicate", [issueAdapter(), issueAdapter()], "PROVIDER_ADAPTER_DUPLICATE"],
    ["unknown provider", [issueAdapter({ providerId: "missing" })], "PROVIDER_NOT_FOUND"],
    ["role mismatch", [issueAdapter({ role: "repository" })], "PROVIDER_ADAPTER_MISMATCH"],
    ["backend mismatch", [issueAdapter({ backend: "kf" })], "PROVIDER_ADAPTER_MISMATCH"],
    ["capability mismatch", [issueAdapter({ capabilities: ["issue.list"] })], "PROVIDER_ADAPTER_MISMATCH"],
  ] as const)("rejects %s adapters structurally", (_name, adapters, code) => {
    expect(() => new ProviderAdapterRegistry(new ProviderRegistry(), adapters)).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects adapters whose declared provider identity is not trusted", () => {
    const injected = { ...github, id: "injected" } as ProviderDescriptor;
    expect(() => new ProviderRegistry([injected])).toThrowError(expect.objectContaining({ code: "UNTRUSTED_PROVIDER_INJECTION" }));
  });
});

describe("provider service", () => {
  it("checks capabilities before adapter invocation", async () => {
    const invoke = vi.fn();
    const service = new ProviderService(new ProviderRegistry(), [issueAdapter({ invoke })]);
    await expect(service.invoke({ providerId: "github", capability: "ci.logs", route: "github-personal", input: {} })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED", capability: "ci.logs" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires a configured route before invoking route-bound adapters", async () => {
    const invoke = vi.fn();
    const service = new ProviderService(new ProviderRegistry(), [issueAdapter({ invoke })]);
    await expect(service.invoke({ providerId: "github", capability: "issue.list", input: {} })).rejects.toMatchObject({ code: "PROVIDER_ROUTE_REQUIRED" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a missing KanbanFlow route before fake process execution", async () => {
    const invoke = vi.fn();
    const service = new ProviderService(new ProviderRegistry(), [kanbanFlowAdapter(invoke)]);
    await expect(service.invoke({ providerId: "kanbanflow", capability: "issue.list", input: {} })).rejects.toMatchObject({ code: "PROVIDER_ROUTE_REQUIRED" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes the matching adapter with an opaque route label and normalized request", async () => {
    const invoke = vi.fn(async () => ["ok"]);
    const service = new ProviderService(new ProviderRegistry(), [issueAdapter({ invoke })]);
    const result = service.invoke({ providerId: "github", capability: "issue.list", route: "github-personal", input: { state: "open" } });
    expectTypeOf(result).toEqualTypeOf<Promise<readonly IssueV1[]>>();
    await expect(result).resolves.toEqual(["ok"]);
    expect(invoke).toHaveBeenCalledWith({ providerId: "github", capability: "issue.list", route: "github-personal", input: { state: "open" } });
  });

  it("denies workflow-policy actions before invoking an adapter", async () => {
    const invoke = vi.fn();
    const service = new ProviderService(new ProviderRegistry(), [issueAdapter({ invoke })], { authorize: () => false });
    await expect(service.invoke({ providerId: "github", capability: "issue.finish", route: "github-personal", input: { id: "42" } })).rejects.toMatchObject({ code: "WORKFLOW_POLICY_DENIED" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
