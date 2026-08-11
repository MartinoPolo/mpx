import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MpxError } from "@mpx/core";
import { PortService, RealGitWorktreeAdapter, RegistryStore } from "@mpx/ports";
import { createStatusProvider, type StatusProvider } from "@mpx/status";
import { WindowsPortPlatformAdapter } from "@mpx/windows";

export type CliPortService = Pick<PortService, "ensure" | "resolve" | "list" | "inspect" | "kill" | "release" | "reconcile" | "rebuild">;

export interface CliContext {
  env: NodeJS.ProcessEnv;
  catalogRoot?: string;
  portService?: CliPortService;
  portServiceFactory?: (stateRoot: string) => CliPortService;
  statusProvider?: StatusProvider;
  statusProviderFactory?: (portService: CliPortService) => StatusProvider;
}
export const defaultContext: CliContext = { env: process.env };

export function stateRoot(context: CliContext): string {
  const localAppData = context.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) throw new MpxError({
    code: "STATE_ROOT_UNAVAILABLE",
    message: "LOCALAPPDATA must be an absolute path.",
    remediation: "Set LOCALAPPDATA to an absolute user-local application data directory.",
  });
  return path.join(localAppData, "mpx");
}

export function ports(context: CliContext): CliPortService {
  if (context.portService) return context.portService;
  const root = stateRoot(context);
  return context.portServiceFactory?.(root) ?? new PortService({
    store: new RegistryStore(root),
    git: new RealGitWorktreeAdapter(),
    platform: new WindowsPortPlatformAdapter(),
  });
}

export function status(context: CliContext, service?: CliPortService): StatusProvider {
  if (context.statusProvider) return context.statusProvider;
  const selected = service ?? ports(context);
  return context.statusProviderFactory?.(selected) ?? createStatusProvider({ portService: selected });
}

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
