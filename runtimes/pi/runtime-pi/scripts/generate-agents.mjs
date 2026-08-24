import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePiAgents } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../");
const source = path.join(root, "content", "agents");
const output = path.join(here, "..", "projection", "agents");
const names = (await readdir(source)).filter((name) => /^mpx-[a-z0-9-]+\.md$/u.test(name));
const mappings = Object.fromEntries(names.map((file) => {
  const identity = file.slice(0, -3);
  const readOnly = /(?:checker|reviewer|scanner|explorer|analyzer|finder|tester)/u.test(identity);
  return [identity, { model: readOnly ? "openai-codex/gpt-5.6-luna" : "openai-codex/gpt-5.6-sol", tools: readOnly ? ["read", "grep", "find", "ls", "bash"] : ["read", "grep", "find", "ls", "bash", "edit", "write"] }];
}));
const check = process.argv.includes("--check");
const result = await generatePiAgents({ source, output, mappings, check });
if (result.drift.length) {
  console.error(`Generated Pi agents drifted: ${result.drift.join(", ")}`);
  process.exitCode = 1;
} else if (!check) console.log(`Generated ${result.changed.length} Pi agents.`);
