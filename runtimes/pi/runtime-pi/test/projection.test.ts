import { expect, it } from "vitest";
import { createPiProjection } from "../src/index.js";
it("projects retained Pi UX and vendored orchestration without host mutation", () => {
  const p = createPiProjection();
  expect(p.settings).toMatchObject({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, terminal: { showTerminalProgress: false }, tuiMode: "fullscreen", theme: "dark", enableSkillCommands: false });
  expect(p.keybindings["app.model.select"]).toBe("alt+p");
  expect(p.themes.map(x => [x.name, x.status])).toEqual([["dark", "active"], ["green", "identity-canvas"], ["amber", "identity-canvas"]]);
  expect(p.adapters).toEqual(["compact", "guard", "auto-title", "fullscreen", "events", "footer"]);
  expect(p.subagents).toMatchObject({ enabled: true, nestedOrchestration: true, fleetView: true, provenance: expect.stringContaining("projection/imported provenance only") });
  expect(p.accountProfiles).toEqual({ kind: "projection-only", mutation: "unsupported" });
  expect(p.unsupported).toContain("F2 host replacement");
});
