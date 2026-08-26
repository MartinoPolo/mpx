import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PowerShellResult, PowerShellRunner } from "./adapter.js";
import { ProductionWindowsResourceStore } from "./production-resource.js";

class Runner implements PowerShellRunner {
  calls: { script: string; parameters?: Readonly<Record<string, string>> }[] = [];
  outputs: string[] = [];
  async run(script: string, parameters?: Readonly<Record<string, string>>): Promise<PowerShellResult> {
    this.calls.push({ script, parameters });
    return { stdout: this.outputs.shift() ?? '{"ok":true}', stderr: "", exitCode: 0 };
  }
}

describe("ProductionWindowsResourceStore", () => {
  it("passes registry values only through structured JSON instead of interpolating shell text", async () => {
    const runner = new Runner();
    runner.outputs.push('{"owner":"mpx","MPX_APPS":"C:\\\\Apps"}', '{"ok":true}', '{"owner":"mpx","MPX_APPS":"C:\\\\Apps; Write-Host pwn"}');
    const store = new ProductionWindowsResourceStore({ platform: "win32", runner });
    expect(await store.read("HKCU\\Environment")).toEqual({ owner: "mpx", MPX_APPS: "C:\\Apps" });
    await store.write("HKCU\\Environment", { owner: "mpx", MPX_APPS: "C:\\Apps; Write-Host pwn" });
    expect(runner.calls[1]!.script).not.toContain("Write-Host pwn");
    expect(JSON.parse(runner.calls[1]!.parameters!.NativeResourceJson)).toEqual({ target: "HKCU\\Environment", value: { owner: "mpx", MPX_APPS: "C:\\Apps; Write-Host pwn" } });
  });

  it("uses terminating native mutations and verifies desired or absent state", async () => {
    const runner = new Runner();
    runner.outputs.push('{"ok":true}', '{"owner":"mpx","MPX_APPS":"C:\\\\Apps"}', '{"ok":true}', 'null');
    const store = new ProductionWindowsResourceStore({ platform: "win32", runner });
    await store.write("HKCU\\Environment", { owner: "mpx", MPX_APPS: "C:\\Apps" });
    await store.remove("HKCU\\Environment");
    expect(runner.calls[0]!.script).toContain("$ErrorActionPreference='Stop'");
    expect(runner.calls[2]!.script).toContain("$ErrorActionPreference='Stop'");
    expect(runner.calls).toHaveLength(4);
  });

  it("uses native shortcut and scheduled-task operations with exact structured identities", async () => {
    const runner = new Runner();
    const store = new ProductionWindowsResourceStore({ platform: "win32", runner });
    const shortcut = "C:\\Users\\me\\Desktop\\MPX.lnk", shortcutValue = { owner: "mpx", targetPath: "C:\\Apps\\mpx.cmd", argv: [], workingDirectory: "C:\\Users\\me" };
    runner.outputs.push('{"ok":true}', JSON.stringify({ ...shortcutValue, arguments: "" }), '{"ok":true}', 'null');
    await store.write(shortcut, shortcutValue);
    await store.remove(shortcut);
    const task = "\\MPX\\Session Capture", taskValue = { owner: "mpx", executable: "C:\\node.exe", argv: ["C:\\Apps\\mpx\\releases\\" + "a".repeat(64) + "\\bin\\mpx.mjs", "session"], principal: "DOMAIN\\me", logonType: "InteractiveToken", runLevel: "LeastPrivilege" };
    runner.outputs.push('{"ok":true}', JSON.stringify({ ...taskValue, arguments: '"' + taskValue.argv[0] + '" session' }), '{"started":true}');
    await store.write(task, taskValue);
    await store.runScheduledTask(task);
    expect(runner.calls.map(call => JSON.parse(call.parameters!.NativeResourceJson).target)).toEqual([shortcut, shortcut, shortcut, shortcut, task, task, task]);
    expect(runner.calls[4]!.script).toContain("Register-ScheduledTask");
    expect(runner.calls[6]!.script).toContain("Start-ScheduledTask");
    expect(runner.calls.every(call => !call.script.includes(shortcut) && !call.script.includes("DOMAIN\\me"))).toBe(true);
  });

  it("parses production PowerShell scheduled-task fixture with hashes, trigger, and settings", async () => {
    const runner = new Runner();
    runner.outputs.push(await readFile(fileURLToPath(new URL("../test/fixtures/powershell-scheduled-task.json", import.meta.url)), "utf8"));
    const store = new ProductionWindowsResourceStore({ platform: "win32", runner });
    await expect(store.read("\\MPX\\Session Capture")).resolves.toMatchObject({ executableSha256: "a".repeat(64), cliSha256: "b".repeat(64), argv: ["C:\\MPX Apps\\mpx.mjs", "session", "reconcile"], trigger: { cadenceMinutes: 10 }, settings: { multipleInstances: "IgnoreNew", executionTimeLimitSeconds: 300 } });
  });

  it("returns structured manual-run status evidence", async () => {
    const runner = new Runner();
    runner.outputs.push('{"exists":true,"state":"Ready","lastResult":0,"lastRunAt":"2025-01-01T00:00:00.000Z"}');
    const store = new ProductionWindowsResourceStore({ platform: "win32", runner });
    await expect(store.inspectScheduledTaskStatus("\\MPX\\Session Capture")).resolves.toEqual({ exists: true, state: "Ready", lastResult: 0, lastRunAt: "2025-01-01T00:00:00.000Z" });
    expect(runner.calls[0]!.script).toContain("Get-ScheduledTaskInfo");
  });

  it("rejects unsupported targets before invoking PowerShell", async () => {
    const runner = new Runner();
    const store = new ProductionWindowsResourceStore({ platform: "win32", runner });
    await expect(store.read("HKCU\\Software\\Foreign")).rejects.toMatchObject({ code: "WINDOWS_RESOURCE_INVALID" });
    expect(runner.calls).toHaveLength(0);
  });
});
