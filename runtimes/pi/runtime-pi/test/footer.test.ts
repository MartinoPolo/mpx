import { expect, it } from "vitest";
import { createPiFooterPortAdapter } from "../src/index.js";
const base = { schemaVersion: 1, project: { id: "p", cwd: "C:/p" }, worktree: { id: null, path: null, role: null, branch: null }, diagnostics: [] } as const;
it("renders shared validated port status asynchronously", async () => {
  let release!: (v: unknown) => void; const pending = new Promise<unknown>(r => release = r);
  const footer = createPiFooterPortAdapter(async () => pending);
  expect(footer.current()).toBe("");
  const refresh = footer.refresh();
  release({ ...base, portResolution: "valid", services: [{ id: "web", mode: "managed", scope: "checkout", protocol: "http", port: 4310, listening: true, conflict: "none", pid: 1 }] });
  await refresh;
  expect(footer.current()).toBe("ports web:4310*");
});
it("shows post-launch valid, stale, invalid, and missing updates from the reader",async()=>{let value:unknown={...base,portResolution:"valid",services:[]};const footer=createPiFooterPortAdapter(async()=>value);await footer.refresh();expect(footer.current()).toBe("ports none");for(const state of ["stale","invalid","missing"] as const){value={...base,portResolution:state,services:[]};await footer.refresh();expect(footer.current()).toBe(`ports ${state}`);}});
