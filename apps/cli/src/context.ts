import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CliContext {
  env: NodeJS.ProcessEnv;
  catalogRoot?: string;
}
export const defaultContext: CliContext = { env: process.env };

async function exists(candidate: string): Promise<boolean> {
  try { await access(candidate); return true; } catch { return false; }
}

/** Locate only the repository-owned canonical catalog; callers may inject a fixture root. */
export async function catalogPath(context: CliContext, cwd: string): Promise<string> {
  if (context.catalogRoot) return context.catalogRoot;
  let directory = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(directory, "content", "skills");
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // The package is normally two levels below the repository root.
  const packaged = fileURLToPath(new URL("../../../content/skills", import.meta.url));
  if (await exists(packaged)) return packaged;
  throw new Error("Canonical skill catalog was not found.");
}
