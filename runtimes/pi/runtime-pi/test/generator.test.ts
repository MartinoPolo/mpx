import { mkdtemp, readFile, writeFile } from "node:fs/promises"; import { tmpdir } from "node:os"; import path from "node:path";
import { expect, it } from "vitest"; import { generatePiAgents } from "../src/index.js";
import { fileURLToPath } from "node:url";
it("generates runtime metadata, the Explore alias, and detects exact catalog drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-")); const source = path.join(root, "source"); const output = path.join(root, "out");
  await import("node:fs/promises").then(x => x.mkdir(source));
  await writeFile(path.join(source, "mpx-explorer.md"), "---\nname: mpx-explorer\ndescription: Exact Explore description\n---\nBody\n");
  await writeFile(path.join(source, "metadata.json"), JSON.stringify({ schemaVersion: 1, agents: { "mpx-explorer": { modelClass: "terra", thinking: "low", capabilities: ["read", "search", "shell"], nesting: [], outputSchema: "text" } } }));
  expect(await generatePiAgents({ source, output })).toEqual({ changed: ["Explore.md"], drift: [] });
  const projected = await readFile(path.join(output, "Explore.md"), "utf8");
  expect(projected).toContain("name: Explore\ndescription: Exact Explore description\nmodel: openai-codex/gpt-5.6-terra\nthinking: low\ntools: read,grep,find,ls,bash\noutput_schema: text");
  expect(projected).not.toContain("model: inherit");
  await expect(readFile(path.join(output, "mpx-explorer.md"), "utf8")).rejects.toThrow();
  await writeFile(path.join(output, "mpx-stale.md"), "stale");
  expect((await generatePiAgents({ source, output, check: true })).drift).toEqual(["mpx-stale.md"]);
  await writeFile(path.join(output, "notes.md"), "unrelated");
  await generatePiAgents({ source, output });
  await expect(readFile(path.join(output, "mpx-stale.md"), "utf8")).rejects.toThrow();
  await expect(readFile(path.join(output, "notes.md"), "utf8")).resolves.toBe("unrelated");
});

it("keeps the maintained projection at exactly 22 agents with one Explore alias and no drift", async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = path.resolve(packageRoot, "../../../content/agents");
  const output = path.join(packageRoot, "projection/agents");
  const result = await generatePiAgents({ source, output, check: true });
  expect(result.drift).toEqual([]);
  const names = (await import("node:fs/promises").then(fs => fs.readdir(output))).filter(name => name.endsWith(".md"));
  expect(names).toHaveLength(22);
  expect(names.filter(name => name === "Explore.md")).toHaveLength(1);
  expect(names).not.toContain("mpx-explorer.md");
});

it("expands approved nesting patterns to concrete canonical identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-nesting-")); const source = path.join(root, "source"); const output = path.join(root, "out");
  await import("node:fs/promises").then(x => x.mkdir(source));
  const metadata = { modelClass: "terra", thinking: "low", capabilities: ["read"], nesting: [], outputSchema: "text" };
  for (const identity of ["mpx-parent", "mpx-reviewer-a", "mpx-reviewer-b"]) await writeFile(path.join(source, `${identity}.md`), `---\nname: ${identity}\ndescription: ${identity}\n---\nBody\n`);
  await writeFile(path.join(source, "metadata.json"), JSON.stringify({ schemaVersion: 1, agents: { "mpx-parent": { ...metadata, nesting: ["mpx-reviewer-*"] }, "mpx-reviewer-a": metadata, "mpx-reviewer-b": metadata } }));
  await generatePiAgents({ source, output });
  const projected = await readFile(path.join(output, "mpx-parent.md"), "utf8");
  expect(projected).toContain("allowed_subagents: mpx-reviewer-a,mpx-reviewer-b");
  expect(projected).not.toContain("*");
});
