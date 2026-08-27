import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConvergenceManifest, compareConvergenceManifests, mergeReviewedDecisions, validateConvergenceManifest } from "./convergence-manifest.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projects = process.env.MPX_PROJECTS;
if (!projects) throw new Error("MPX_PROJECTS is required; source roots are never guessed");

const sources = [
  { id: "claude", root: path.join(projects, "mpx-claude-code"), symbolicRoot: "${MPX_PROJECTS}/mpx-claude-code" },
  { id: "pi", root: path.join(projects, "mpx-pi"), symbolicRoot: "${MPX_PROJECTS}/mpx-pi" },
];
const target = path.join(repositoryRoot, "docs", "history", "CONVERGENCE_MANIFEST.json");
const generated = await buildConvergenceManifest({ sources });
const invalid = validateConvergenceManifest(generated, { gate: false });
if (invalid.length) throw new Error(invalid.map(item => `${item.code}: ${item.file}: ${item.message}`).join("\n"));

if (process.argv.includes("--check")) {
  let committed;
  try { committed = JSON.parse(await readFile(target, "utf8")); }
  catch { throw new Error("Committed convergence manifest is missing or invalid; run pnpm convergence:generate"); }
  const diagnostics = [...validateConvergenceManifest(committed, { gate: false }), ...compareConvergenceManifests(committed, generated)];
  if (diagnostics.length) {
    for (const item of diagnostics) console.error(`${item.code}: ${item.file}: ${item.message}`);
    process.exitCode = 1;
  } else console.log(`Verified ${generated.entries.length} convergence entries across ${generated.sources.length} sources.`);
} else {
  let committed;
  try { committed = JSON.parse(await readFile(target, "utf8")); } catch { committed = null; }
  const reconciled = mergeReviewedDecisions(generated, committed);
  await writeFile(target, `${JSON.stringify(reconciled, null, 2)}\n`);
  console.log(`Wrote ${reconciled.entries.length} convergence entries to ${path.relative(repositoryRoot, target)} while preserving unchanged reviewed decisions.`);
}
