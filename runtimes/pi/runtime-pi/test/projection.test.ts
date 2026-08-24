import { expect, it } from "vitest";
import { createPiProjection } from "../src/index.js";
it("projects retained Pi UX and vendored orchestration without host mutation", () => {
  const p = createPiProjection();
  expect(p.settings).toMatchObject({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, tuiMode: "fullscreen", theme: "green", enableSkillCommands: false });
  expect(p.keybindings["app.model.select"]).toBe("alt+p");
  expect(p.themes.map(x => [x.name, x.status])).toEqual([["green", "active"], ["amber", "retained"]]);
  expect(p.adapters).toEqual(["compact", "guard", "auto-title", "fullscreen", "footer"]);
  expect(p.subagents).toMatchObject({ enabled: false, nestedOrchestration: false, fleetView: false, provenance: expect.stringContaining("projection/imported provenance only") });
  expect(p.accountProfiles).toEqual({ kind: "projection-only", mutation: "unsupported" });
  expect(p.unsupported).toContain("F2 host replacement");
});
