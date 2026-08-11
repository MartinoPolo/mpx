import type { StatusSnapshotV1 } from "./provider.js";

export function renderPortSegment(snapshot: StatusSnapshotV1): string {
  if (snapshot.portResolution !== "valid") return `ports ${snapshot.portResolution}`;
  if (snapshot.services.length === 0) return "ports none";
  const services = [...snapshot.services].sort((a, b) => a.id.localeCompare(b.id));
  return `ports ${services.map((service) => {
    const suffix = service.conflict === "external" ? "!" : service.conflict === "unknown" ? "?" : service.listening ? "*" : "";
    return `${service.id}:${service.port ?? "?"}${suffix}`;
  }).join(" ")}`;
}
export function renderClaudeFixture(snapshot: StatusSnapshotV1): string { return renderPortSegment(snapshot); }
export function renderPiFixture(snapshot: StatusSnapshotV1): string { return renderPortSegment(snapshot); }
