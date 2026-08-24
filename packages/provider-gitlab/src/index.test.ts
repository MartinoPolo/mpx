import { describe, expect, it } from "vitest";
import { defineIssueAdapterConformance } from "@mpx/providers/testing";
import type { IssueCapability, ProviderProcessExecutor, ProviderProcessRequest, ProviderProcessResult } from "@mpx/providers";
import { createGitLabAdapters, gitlabProvider } from "./index.js";

class FakeGlab implements ProviderProcessExecutor {
  readonly requests: ProviderProcessRequest[] = [];
  issues: Array<{ iid: number; title: string; description: string; state: string; labels: string[]; web_url: string; assignees: Array<{ username: string }>; project_id: number }> = [{ iid: 1, title: "Seed", description: "Initial", state: "opened", labels: [], web_url: "https://gitlab.test/g/p/-/issues/1", assignees: [], project_id: 9 }];
  mrs = [{ iid: 7, title: "Draft: Seed MR", state: "opened", draft: true, source_branch: "feature", target_branch: "main", web_url: "https://gitlab.test/g/p/-/merge_requests/7", project_id: 9 }];
  notes: Record<string, Array<Record<string, unknown>>> = {};
  nextIssue = 2;

  async execute(request: ProviderProcessRequest): Promise<ProviderProcessResult> {
    this.requests.push(request);
    const a = request.argv;
    const json = (value: unknown): ProviderProcessResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
    const fields = Object.fromEntries(a.filter((_v, i) => a[i - 1] === "--raw-field").map(v => { const at = v.indexOf("="); return [v.slice(0, at), v.slice(at + 1)]; }));

    if (a[1] === "issue" && a[2] === "list") return json(this.issues);
    if (a[1] === "issue" && a[2] === "view") return json(this.issues.find(issue => String(issue.iid) === a[3]));
    if (a[1] === "issue" && a[2] === "close") { const issue = this.issues.find(item => String(item.iid) === a[3])!; issue.state = "closed"; return json({}); }
    if (a[1] === "mr" && a[2] === "view") return json(this.mrs.find(mr => String(mr.iid) === a[3]));
    if (a[1] === "mr" && a[2] === "update" && a.includes("--ready")) { const mr = this.mrs.find(item => String(item.iid) === a[3])!; mr.draft = false; mr.title = mr.title.replace(/^Draft:\s*/, ""); return json({}); }
    if (a[1] === "mr" && a[2] === "merge") { const mr = this.mrs.find(item => String(item.iid) === a[3])!; mr.state = "merged"; return json({}); }
    if (a[1] === "ci" && a[2] === "trace") return { exitCode: 0, stdout: "safe job log\n", stderr: "" };
    if (a[1] === "ci" && a[2] === "retry") return json({});
    if (a[1] === "api") {
      const endpoint = a[2]!;
      const pipelineJobs = endpoint.match(/^projects\/:fullpath\/pipelines\/(\d+)\/jobs$/);
      if (pipelineJobs) return json([{ id: 44, name: "test", status: "success", web_url: "https://gitlab.test/jobs/44", pipeline_id: Number(pipelineJobs[1]) }]);
      const pipeline = endpoint.match(/^projects\/:fullpath\/pipelines\/(\d+)$/);
      if (pipeline) return json({ id: Number(pipeline[1]), status: "success" });
      if (endpoint === "projects/:fullpath/issues" && a.includes("POST")) {
        const issue = { iid: this.nextIssue++, title: fields.title!, description: fields.description ?? "", state: "opened", labels: [], web_url: "https://gitlab.test/issue", assignees: [], project_id: 9 };
        this.issues.push(issue); return json(issue);
      }
      const issueMatch = endpoint.match(/^projects\/:fullpath\/issues\/(\d+)$/);
      if (issueMatch) { const issue = this.issues.find(item => String(item.iid) === issueMatch[1])!; if (fields.title) issue.title = fields.title; if (fields.description !== undefined) issue.description = fields.description; if (fields.add_labels) issue.labels.push(fields.add_labels); return json(issue); }
      const issueNote = endpoint.match(/^projects\/:fullpath\/issues\/(\d+)\/notes$/);
      if (issueNote) return json({ id: 81, body: fields.body, author: { username: "tester" }, created_at: "2026-01-02T03:04:05Z" });
      if (endpoint === "projects/:fullpath/merge_requests") { const mr = { iid: 8, title: fields.title!, description: fields.description, state: "opened", draft: /^draft:\s*/i.test(fields.title!), source_branch: fields.source_branch!, target_branch: fields.target_branch!, web_url: "https://gitlab.test/mr/8", project_id: 9 }; this.mrs.push(mr); return json(mr); }
      const mrMatch = endpoint.match(/^projects\/:fullpath\/merge_requests\/(\d+)$/);
      if (mrMatch) { const mr = this.mrs.find(item => String(item.iid) === mrMatch[1])!; if (fields.title) mr.title = fields.title; return json(mr); }
      const mrNote = endpoint.match(/^projects\/:fullpath\/merge_requests\/(\d+)\/notes$/);
      if (mrNote) return json({ id: 91, body: fields.body, author: { username: "reviewer" }, created_at: "2026-02-03T04:05:06Z" });
    }
    return { exitCode: 2, stdout: "", stderr: `unexpected ${a.join(" ")}` };
  }
}

const setup = (executor = new FakeGlab(), options: Parameters<typeof createGitLabAdapters>[1] = {}) => {
  const [issues, repository] = createGitLabAdapters(executor, options);
  return { executor, issues, repository };
};

describe("GitLab provider metadata", () => {
  it("declares the trusted backend, both roles, and only implemented capabilities", () => {
    expect(gitlabProvider).toMatchObject({ providerId: "gitlab", backend: "glab", roles: ["repository", "issues"] });
    expect(gitlabProvider.capabilities).not.toContain("issue.move");
  });
});

defineIssueAdapterConformance("GitLab issue adapter", () => {
  const { issues } = setup();
  return { capabilities: issues.capabilities as readonly IssueCapability[], invoke: (capability, input) => issues.invoke({ providerId: "gitlab", capability, route: "work", input: input as never }) };
});

describe("GitLab unsupported operations", () => {
  it("rejects issue movement structurally before invoking glab", async () => {
    const { executor, issues } = setup();
    await expect(issues.invoke({ providerId: "gitlab", capability: "issue.move", input: { id: "1", destination: "Done" } })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED", capability: "issue.move", retryable: false });
    expect(executor.requests).toEqual([]);
  });

  it("rejects unsafe hosted identifiers before invoking glab", async () => {
    const { executor, issues, repository } = setup();
    for (const id of ["https://gitlab.test/acme/project/-/issues/7", "-Rother/project", "other/project#7", "../7", "01", "0"]) {
      await expect(issues.invoke({ providerId: "gitlab", capability: "issue.view", input: { id } })).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
      await expect(repository.invoke({ providerId: "gitlab", capability: "ci.logs", input: { runId: id } })).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
    }
    expect(executor.requests).toEqual([]);
  });

  it("validates repository selectors before adapter invocation", () => {
    expect(() => createGitLabAdapters(new FakeGlab(), { repository: "https://gitlab.test/acme/project" })).toThrowError(expect.objectContaining({ code: "PROVIDER_INVALID" }));
  });
});

describe("GitLab review adapter", () => {
  it("normalizes a merge request view and keeps GitLab fields namespaced", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "review.view", route: "work", input: { id: "7" } })).resolves.toMatchObject({ id: "7", title: "Seed MR", state: "draft", sourceBranch: "feature", targetBranch: "main", providerData: { gitlab: { iid: 7, projectId: 9, draft: true } } });
    expect(executor.requests[0]).toEqual({ argv: ["glab", "mr", "view", "7", "--output", "json"], route: "work" });
  });

  it("binds representative issue, review, and CI commands to an explicit repository", async () => {
    const requests: ProviderProcessRequest[] = [];
    const executor: ProviderProcessExecutor = { execute: async request => {
      requests.push(request);
      if (request.argv[2]?.endsWith("pipelines/12/jobs")) return { exitCode: 0, stdout: "[]", stderr: "" };
      if (request.argv[2]?.endsWith("pipelines/12")) return { exitCode: 0, stdout: JSON.stringify({ id: 12, status: "success" }), stderr: "" };
      if (request.argv[2]?.endsWith("/issues")) return { exitCode: 0, stdout: JSON.stringify({ iid: 1, title: "Issue", description: "Body", state: "opened", labels: [], assignees: [] }), stderr: "" };
      if (request.argv[2]?.endsWith("/merge_requests")) return { exitCode: 0, stdout: JSON.stringify({ iid: 8, title: "MR", state: "opened", draft: false, source_branch: "feature", target_branch: "main" }), stderr: "" };
      if (request.argv[1] === "mr") return { exitCode: 0, stdout: JSON.stringify({ iid: 7, title: "MR", state: "opened", draft: false, source_branch: "feature", target_branch: "main" }), stderr: "" };
      return { exitCode: 0, stdout: "[]", stderr: "" };
    } };
    const [issues, repository] = createGitLabAdapters(executor, { repository: "gitlab.example/acme/project" });
    await issues.invoke({ providerId: "gitlab", capability: "issue.list", input: {} });
    await issues.invoke({ providerId: "gitlab", capability: "issue.create", input: { title: "Issue", body: "Body" } });
    await repository.invoke({ providerId: "gitlab", capability: "review.view", input: { id: "7" } });
    await repository.invoke({ providerId: "gitlab", capability: "review.create", input: { title: "MR", body: "Body", sourceBranch: "feature", targetBranch: "main" } });
    await repository.invoke({ providerId: "gitlab", capability: "ci.status", input: { id: "12" } });
    expect(requests.map(request => request.argv)).toEqual([
      ["glab", "issue", "list", "--output", "json", "--repo", "gitlab.example/acme/project"],
      ["glab", "api", "projects/acme%2Fproject/issues", "--hostname", "gitlab.example", "--method", "POST", "--raw-field", "title=Issue", "--raw-field", "description=Body"],
      ["glab", "mr", "view", "7", "--output", "json", "--repo", "gitlab.example/acme/project"],
      ["glab", "api", "projects/acme%2Fproject/merge_requests", "--hostname", "gitlab.example", "--method", "POST", "--raw-field", "title=MR", "--raw-field", "description=Body", "--raw-field", "source_branch=feature", "--raw-field", "target_branch=main"],
      ["glab", "api", "projects/acme%2Fproject/pipelines/12", "--hostname", "gitlab.example"],
      ["glab", "api", "projects/acme%2Fproject/pipelines/12/jobs", "--hostname", "gitlab.example"],
    ]);
  });

  it("creates draft merge requests with literal raw fields and no file expansion", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "review.create", input: { title: "@release", body: "@body.md", sourceBranch: "@topic", targetBranch: "main", draft: true } })).resolves.toMatchObject({ id: "8", title: "@release", state: "draft" });
    expect(executor.requests[0]?.argv).toEqual(["glab", "api", "projects/:fullpath/merge_requests", "--method", "POST", "--raw-field", "title=Draft: @release", "--raw-field", "description=@body.md", "--raw-field", "source_branch=@topic", "--raw-field", "target_branch=main"]);
    expect(executor.requests[0]?.argv).not.toContain("--field");
  });

  it("does not double-prefix an explicitly drafted title", async () => {
    const { executor, repository } = setup();
    await repository.invoke({ providerId: "gitlab", capability: "review.create", input: { title: "Draft: Existing", body: "Body", sourceBranch: "topic", targetBranch: "main", draft: true } });
    expect(executor.requests[0]?.argv).toContain("title=Draft: Existing");
    expect(executor.requests[0]?.argv).not.toContain("title=Draft: Draft: Existing");
  });

  it("updates a merge request using an argv field without shell parsing", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "review.update", input: { id: "7", title: "Updated" } })).resolves.toMatchObject({ id: "7", title: "Updated" });
    expect(executor.requests[0]?.argv).toContain("title=Updated");
    expect(executor.requests[0]).not.toHaveProperty("shell");
  });

  it("returns a normalized merge request comment", async () => {
    const { repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "review.comment", input: { id: "7", body: "Looks good" } })).resolves.toEqual({ schemaVersion: 1, id: "91", reviewId: "7", body: "Looks good", author: "reviewer", createdAt: "2026-02-03T04:05:06Z", providerData: { gitlab: { noteId: 91 } } });
  });

  it("marks a draft merge request ready then reads structured state", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "review.ready", input: { id: "7" } })).resolves.toMatchObject({ id: "7", state: "open" });
    expect(executor.requests.map(r => r.argv)).toEqual([["glab", "mr", "update", "7", "--ready", "--yes"], ["glab", "mr", "view", "7", "--output", "json"]]);
  });

  it.each([
    ["merge", []],
    ["squash", ["--squash"]],
    ["rebase", ["--rebase"]],
  ] as const)("merges with the validated %s method then reads structured state", async (method, methodArguments) => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "review.merge", input: { id: "7", method } })).resolves.toMatchObject({ id: "7", state: "merged" });
    expect(executor.requests.map(r => r.argv)).toEqual([["glab", "mr", "merge", "7", "--yes", ...methodArguments], ["glab", "mr", "view", "7", "--output", "json"]]);
  });

  it("rejects an unsupported merge method before invoking glab", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "review.merge", input: { id: "7", method: "octopus" } })).rejects.toMatchObject({ code: "PROVIDER_INVALID", capability: "review.merge" });
    expect(executor.requests).toEqual([]);
  });
});

describe("GitLab CI adapter", () => {
  it("normalizes the explicitly requested pipeline and jobs", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.status", route: "work", input: { id: "12" } })).resolves.toEqual({ schemaVersion: 1, state: "passed", checks: [{ id: "44", name: "test", state: "passed", url: "https://gitlab.test/jobs/44", providerData: { gitlab: { jobId: 44, pipelineId: 12 } } }], providerData: { gitlab: { checkCount: 1, pipelineId: 12 } } });
    expect(executor.requests).toEqual([
      { argv: ["glab", "api", "projects/:fullpath/pipelines/12"], route: "work" },
      { argv: ["glab", "api", "projects/:fullpath/pipelines/12/jobs"], route: "work" },
    ]);
  });

  it("starts the one-shot pipeline and jobs requests concurrently", async () => {
    const requests: ProviderProcessRequest[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>(resolve => { release = resolve; });
    const executor: ProviderProcessExecutor = { execute: async request => {
      requests.push(request);
      if (requests.length === 2) release();
      await bothStarted;
      return request.argv.at(-1)?.endsWith("/jobs")
        ? { exitCode: 0, stdout: "[]", stderr: "" }
        : { exitCode: 0, stdout: JSON.stringify({ id: 12, status: "success" }), stderr: "" };
    } };
    const [, repository] = createGitLabAdapters(executor);
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.status", input: { id: "12" } })).resolves.toMatchObject({ state: "passed" });
    expect(requests.map(request => request.argv.at(-1))).toEqual(["projects/:fullpath/pipelines/12", "projects/:fullpath/pipelines/12/jobs"]);
  }, 1_000);

  it.each(["ci.status", "ci.watch"] as const)("requires an explicit pipeline id for %s", async capability => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability, input: {} })).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
    expect(executor.requests).toEqual([]);
  });

  it("returns immediately when the explicitly watched pipeline is terminal", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.watch", input: { id: "12" } })).resolves.toMatchObject({ state: "passed" });
    expect(executor.requests.map(r => r.argv)).toEqual([
      ["glab", "api", "projects/:fullpath/pipelines/12"],
      ["glab", "api", "projects/:fullpath/pipelines/12/jobs"],
    ]);
  });

  it("polls only the pipeline until terminal, then fetches jobs once", async () => {
    const requests: ProviderProcessRequest[] = [];
    let pipelineRequests = 0;
    const executor: ProviderProcessExecutor = { execute: async request => {
      requests.push(request);
      if (request.argv.at(-1)?.endsWith("/jobs")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([{ id: 44, name: "test", status: "success" }]) };
      pipelineRequests += 1;
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({ id: 12, status: pipelineRequests === 1 ? "running" : "success" }) };
    } };
    const [, repository] = createGitLabAdapters(executor, { ciWatchPollIntervalMilliseconds: 0 });
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.watch", input: { id: "12" } })).resolves.toMatchObject({ state: "passed" });
    expect(requests.map(request => request.argv)).toEqual([
      ["glab", "api", "projects/:fullpath/pipelines/12"],
      ["glab", "api", "projects/:fullpath/pipelines/12"],
      ["glab", "api", "projects/:fullpath/pipelines/12/jobs"],
    ]);
  });

  it("fails structurally when an explicit pipeline watch times out", async () => {
    const executor: ProviderProcessExecutor = { execute: async request => ({ exitCode: 0, stderr: "", stdout: request.argv.at(-1)?.endsWith("/jobs") ? "[]" : JSON.stringify({ id: 12, status: "running" }) }) };
    const [, repository] = createGitLabAdapters(executor, { ciWatchTimeoutMilliseconds: 0, ciWatchPollIntervalMilliseconds: 0 });
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.watch", input: { id: "12" } })).rejects.toMatchObject({ code: "COMMAND_FAILURE", capability: "ci.watch", retryable: true, details: { providerData: { gitlab: { pipelineId: "12" } } } });
  });

  it("returns normalized requested job logs and prefers runId", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.logs", input: { id: "ignored", runId: "44" } })).resolves.toEqual({ schemaVersion: 1, id: "44", content: "safe job log\n", providerData: { gitlab: { jobId: "44" } } });
    expect(executor.requests[0]?.argv).toEqual(["glab", "ci", "trace", "44"]);
  });

  it("retries the requested job and returns a normalized retry result", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.retry", input: { runId: "44" } })).resolves.toEqual({ schemaVersion: 1, id: "44", providerData: { gitlab: { jobId: "44", retried: true } } });
    expect(executor.requests.map(r => r.argv)).toEqual([["glab", "ci", "retry", "44"]]);
  });

  it("falls back to id for adapter-level log and retry compatibility", async () => {
    const { executor, repository } = setup();
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.logs", input: { id: "44" } })).resolves.toMatchObject({ schemaVersion: 1, id: "44" });
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.retry", input: { id: "44" } })).resolves.toMatchObject({ schemaVersion: 1, id: "44" });
    expect(executor.requests.map(r => r.argv)).toEqual([["glab", "ci", "trace", "44"], ["glab", "ci", "retry", "44"]]);
  });

  it("maps the normalized finished list state to GitLab closed state", async () => {
    const { executor, issues } = setup(new FakeGlab());
    await issues.invoke({ providerId: "gitlab", capability: "issue.list", input: { state: "finished" } });
    expect(executor.requests[0]?.argv).toEqual(["glab", "issue", "list", "--output", "json", "--state", "closed"]);
  });

  it("forwards cwd to every command in both adapters", async () => {
    const { executor, issues, repository } = setup(new FakeGlab(), { cwd: "C:/repo" });
    await issues.invoke({ providerId: "gitlab", capability: "issue.list", input: {} });
    await repository.invoke({ providerId: "gitlab", capability: "ci.status", input: { id: "12" } });
    expect(executor.requests).toHaveLength(3);
    expect(executor.requests.every(request => request.cwd === "C:/repo")).toBe(true);
  });
});

describe("GitLab failures", () => {
  it.each([undefined, null] as const)("normalizes an unavailable issue description to an empty body", async description => {
    const response = { iid: 1, title: "Seed", description, state: "opened", labels: [], assignees: [] };
    const executor: ProviderProcessExecutor = { execute: async () => ({ exitCode: 0, stdout: JSON.stringify(response), stderr: "" }) };
    const [issues] = createGitLabAdapters(executor);
    await expect(issues.invoke({ providerId: "gitlab", capability: "issue.view", input: { id: "1" } })).resolves.toMatchObject({ body: "" });
  });

  it.each([
    ["issue.view", { id: "1" }, { iid: 1, title: "Seed", description: {}, state: "opened", labels: [], assignees: [] }],
    ["issue.view", { id: "1" }, { iid: 1, title: 7, description: "Body", state: "opened", labels: [], assignees: [] }],
    ["issue.view", { id: "1" }, { iid: 1, title: "Seed", description: "Body", state: "unknown", labels: [], assignees: [] }],
    ["issue.view", { id: "1" }, { iid: 1, title: "Seed", description: "Body", labels: [], assignees: [] }],
    ["issue.view", { id: "1" }, { iid: 1, title: "Seed", description: "Body", state: "opened", labels: [7], assignees: [] }],
    ["issue.view", { id: "1" }, { iid: 1, title: "Seed", description: "Body", state: "opened", labels: [], assignees: [{ username: 7 }] }],
    ["review.view", { id: "7" }, { iid: 7, title: "MR", state: "opened", source_branch: {}, target_branch: "main" }],
    ["review.view", { id: "7" }, { iid: 7, title: "MR", state: "mystery", source_branch: "feature", target_branch: "main" }],
    ["review.comment", { id: "7", body: "safe" }, { id: 91, body: 7, author: { username: "reviewer" }, created_at: "2026-02-03T04:05:06Z" }],
  ] as const)("classifies malformed valid JSON returned for %s by mutation risk", async (capability, input, response) => {
    const executor: ProviderProcessExecutor = { execute: async () => ({ exitCode: 0, stdout: JSON.stringify(response), stderr: "" }) };
    const [issues, repository] = createGitLabAdapters(executor);
    const adapter = capability.startsWith("issue.") ? issues : repository;
    await expect(adapter.invoke({ providerId: "gitlab", capability, input })).rejects.toMatchObject({
      code: capability === "review.comment" ? "MUTATION_OUTCOME_UNKNOWN" : "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it.each([
    [{ id: 12, status: "unknown" }, []],
    [{ id: 12 }, []],
    [{ id: 12, status: "success" }, [{ id: 44, name: 7, status: "success" }]],
    [{ id: 12, status: "success" }, [{ id: 44, name: "test", status: "unknown" }]],
  ] as const)("rejects malformed valid CI JSON", async (pipeline, jobs) => {
    const executor: ProviderProcessExecutor = { execute: async request => ({ exitCode: 0, stdout: JSON.stringify(request.argv.at(-1)?.endsWith("/jobs") ? jobs : pipeline), stderr: "" }) };
    const [, repository] = createGitLabAdapters(executor);
    await expect(repository.invoke({ providerId: "gitlab", capability: "ci.status", input: { id: "12" } })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    [{ exitCode: 0, stdout: "{token:secret}", stderr: "" }, "INVALID_RESPONSE"],
    [{ exitCode: 9, stdout: "", stderr: "body=private token=secret" }, "COMMAND_FAILURE"],
    [{ exitCode: 4, stdout: "", stderr: "oauth=secret", failure: "auth" as const }, "AUTH_FAILURE"],
  ])("sanitizes malformed, exit, and authentication failures", async (result, code) => {
    const executor: ProviderProcessExecutor = { execute: async () => result };
    const [issues] = createGitLabAdapters(executor);
    let caught: unknown;
    try { await issues.invoke({ providerId: "gitlab", capability: "issue.list", input: { body: "also-secret" } }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code, details: { providerData: { gitlab: expect.any(Object) } } });
    expect(JSON.stringify(caught)).not.toMatch(/secret|private|also-secret/);
  });
});
