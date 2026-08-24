import { preparationDiagnostics } from "./preparation.js";
import type { Diagnostic, ProjectConfig, UserConfig } from "./types.js";

export function doctor(project: ProjectConfig, user?: UserConfig): Diagnostic[] {
  const out: Diagnostic[] = [...preparationDiagnostics(project)];
  for (const [id, service] of Object.entries(project.development?.services ?? {})) {
    if (service.port.mode === "managed" && service.port.preferred === undefined) out.push({ code: "MANAGED_PORT_UNANCHORED", severity: "warning", message: `Managed service ${id} has no preferred port`, pointer: `/development/services/${id}/port` });
    if (service.port.mode === "fixed-shared") out.push({ code: "FIXED_SHARED_PORT", severity: "warning", message: `Service ${id} may collide across checkouts`, pointer: `/development/services/${id}/port` });
  }
  if (user && !Object.keys(user.domains).length) out.push({ code: "NO_USER_DOMAINS", severity: "info", message: "No user domains configured" });
  if (user && !Object.keys(user.contentScopes).length) out.push({ code: "NO_CONTENT_SCOPES", severity: "info", message: "No content scopes configured" });
  return out.sort((left, right) => (left.pointer ?? "").localeCompare(right.pointer ?? "") || left.code.localeCompare(right.code));
}
