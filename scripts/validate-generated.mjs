import { access } from "node:fs/promises";

for (const path of ["MPX_MIGRATION.md", "AGENTS.md", "package.json", "pnpm-workspace.yaml"]) {
  await access(new URL(`../${path}`, import.meta.url));
}

console.log("Generated artifact prerequisites are present.");
