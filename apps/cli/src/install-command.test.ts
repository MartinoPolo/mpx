import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { installerDigest, type InstallIntentV1, type InstallOrchestrator, type InstallPlanV1 } from "@mpx/installer";
import { executeInstallCommand } from "./install-command.js";

const digest = "a".repeat(64);
const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey: digest, convergenceHash: digest, components: ["cli"] };
const planBase = { schemaVersion: 1 as const, kind: "install-plan" as const, intent, observations: [], operations: [] };
const plan: InstallPlanV1 = { ...planBase, confirmationDigest: installerDigest(planBase) };
async function jsonFile(value: unknown): Promise<string> { const root = await mkdtemp(path.join(tmpdir(), "mpx-cli-install-")), file = path.join(root, "input.json"); await writeFile(file, JSON.stringify(value)); return file; }
const input = (action: string, options: [string, string | boolean][]) => ({ action, args: [], options: new Map<string, string | boolean | string[]>(options) });

it("reads an explicit intent and returns the stable read-only plan", async () => {
  const planMethod = vi.fn(async () => plan), orchestrator = { plan: planMethod } as unknown as InstallOrchestrator;
  const result = await executeInstallCommand(input("plan", [["intent", await jsonFile(intent)]]), { orchestrator });
  expect(planMethod).toHaveBeenCalledWith(intent);
  expect(result.data).toEqual(plan);
});

it("applies only an explicit plan with its exact confirmation", async () => {
  const receipt = { schemaVersion: 1, kind: "ownership-receipt" }, apply = vi.fn(async () => receipt), orchestrator = { apply } as unknown as InstallOrchestrator;
  const result = await executeInstallCommand(input("apply", [["plan", await jsonFile(plan)], ["confirm-plan", plan.confirmationDigest]]), { orchestrator });
  expect(apply).toHaveBeenCalledWith(plan, plan.confirmationDigest);
  expect(result.data).toEqual({ schemaVersion: 1, kind: "install-apply", receipt });
});

it("forwards strict verification and returns the versioned verification", async () => {
  const verification = { schemaVersion: 1, kind: "install-verification", releaseKey: digest, healthy: true, issues: [], checkedAt: "2025-01-01T00:00:00.000Z" }, verify = vi.fn(async () => verification), orchestrator = { verify } as unknown as InstallOrchestrator;
  expect((await executeInstallCommand(input("verify", [["strict", true]]), { orchestrator })).data).toEqual(verification);
  expect(verify).toHaveBeenCalledWith(true);
});

it("requires transaction identity and exact confirmation for rollback", async () => {
  const rollback = vi.fn(async () => ({ schemaVersion: 1, kind: "install-rollback", transactionId: "tx", rolledBack: true as const })), orchestrator = { rollback } as unknown as InstallOrchestrator;
  await executeInstallCommand(input("rollback", [["transaction", "tx"], ["confirm-plan", digest]]), { orchestrator });
  expect(rollback).toHaveBeenCalledWith("tx", digest);
});

it("uninstalls owned state through a mandatory exact confirmation", async () => {
  const uninstall = vi.fn(async () => ({ schemaVersion: 1, kind: "install-uninstall", releaseKey: digest, removed: true as const })), orchestrator = { uninstall } as unknown as InstallOrchestrator;
  await executeInstallCommand(input("uninstall", [["confirm-plan", digest]]), { orchestrator });
  expect(uninstall).toHaveBeenCalledWith(digest);
});
