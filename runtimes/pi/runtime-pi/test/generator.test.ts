import { mkdtemp, readFile, writeFile } from "node:fs/promises"; import { tmpdir } from "node:os"; import path from "node:path";
import { expect, it } from "vitest"; import { generatePiAgents } from "../src/index.js";
it("generates reproducible mpx agents with Pi model/tool mappings and detects drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-")); const source = path.join(root, "source"); const output = path.join(root, "out");
  await import("node:fs/promises").then(x => x.mkdir(source));
  await writeFile(path.join(source, "mpx-checker.md"), "---\nname: mpx-checker\ndescription: Check\n---\nBody\n");
  expect(await generatePiAgents({ source, output, mappings: { "mpx-checker": { model: "gpt-5.6-luna", tools: ["read", "bash"] } } })).toEqual({ changed: ["mpx-checker.md"], drift: [] });
  expect(await readFile(path.join(output, "mpx-checker.md"), "utf8")).toContain("model: gpt-5.6-luna\ntools: read,bash");
  expect((await generatePiAgents({ source, output, mappings: { "mpx-checker": { model: "gpt-5.6-luna", tools: ["read", "bash"] } }, check: true })).drift).toEqual([]);
  await writeFile(path.join(output, "mpx-checker.md"), "drift");
  expect((await generatePiAgents({ source, output, mappings: { "mpx-checker": { model: "gpt-5.6-luna", tools: ["read", "bash"] } }, check: true })).drift).toEqual(["mpx-checker.md"]);
  await writeFile(path.join(output, "mpx-stale.md"), "stale");
  await writeFile(path.join(output, "notes.md"), "unrelated");
  expect((await generatePiAgents({ source, output, mappings: { "mpx-checker": { model: "gpt-5.6-luna", tools: ["read", "bash"] } }, check: true })).drift).toEqual(["mpx-checker.md", "mpx-stale.md"]);
  await generatePiAgents({ source, output, mappings: { "mpx-checker": { model: "gpt-5.6-luna", tools: ["read", "bash"] } } });
  await expect(readFile(path.join(output, "mpx-stale.md"), "utf8")).rejects.toThrow();
  await expect(readFile(path.join(output, "notes.md"), "utf8")).resolves.toBe("unrelated");
});
