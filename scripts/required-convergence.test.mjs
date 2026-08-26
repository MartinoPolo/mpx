import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runRequiredConvergence } from "./required-convergence.mjs";

describe("required source convergence gate", () => {
  it("runs the real drift verifier when both configured legacy source roots exist", async () => {
    const projects = await mkdtemp(path.join(tmpdir(), "mpx-required-convergence-"));
    try {
      await Promise.all([mkdir(path.join(projects, "mpx-claude-code")), mkdir(path.join(projects, "mpx-pi"))]);
      const run = vi.fn(async () => ({ exitCode: 0 }));
      await expect(runRequiredConvergence({ MPX_PROJECTS: projects }, { run })).resolves.toMatchObject({ status: "verified" });
      expect(run).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/generate-convergence-manifest\.mjs$/u), "--check"], expect.objectContaining({ env: expect.objectContaining({ MPX_PROJECTS: projects }) }));
    } finally {
      await rm(projects, { recursive: true, force: true });
    }
  });

  it("prints an explicit skip only when configured source roots are unavailable", async () => {
    const write = vi.fn();
    await expect(runRequiredConvergence({}, { write, run: vi.fn() })).resolves.toEqual(expect.objectContaining({ status: "skipped", reason: "MPX_PROJECTS is not configured" }));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("SKIP convergence:verify"));
  });
});
