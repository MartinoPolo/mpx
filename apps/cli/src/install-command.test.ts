import { expect, it } from "vitest";
import type { InstallerService } from "@mpx/installer";
import { executeInstallCommand } from "./install-command.js";

it("wires immutable runner evidence into installer planning", async () => {
  let request: unknown;
  const service = { plan: async (input: unknown) => { request = input; return { schemaVersion: 1, confirmationDigest: "digest" }; } } as unknown as InstallerService;
  const options = new Map<string, string | boolean | string[]>([["component", "session-capture"], ["runner", "C:\\Program Files\\MPX\\mpx.exe"], ["runner-sha256", "a".repeat(64)], ["runner-version", "1.0.0"]]);
  const result = await executeInstallCommand({ action: "plan", args: [], options }, { service });
  expect(request).toEqual({ componentId: "session-capture", runner: { path: "C:\\Program Files\\MPX\\mpx.exe", sha256: "a".repeat(64), version: "1.0.0" } });
  expect(result.data).toMatchObject({ schemaVersion: 1, confirmationDigest: "digest" });
});
