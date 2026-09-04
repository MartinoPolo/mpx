import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Resolve Pi's data directory, honoring relative overrides against the session cwd. */
export function resolvePiCodingAgentDir(cwd: string): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
