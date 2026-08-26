import { expect, it } from "vitest";
import { FakeBinaryFileSystem, FakeJsonResourceStore } from "@mpx/windows";
import { installerDigest, type InstallIntentV1, type ReleaseManifestV1 } from "./immutable-core.js";
import { ProductionInstallerOperationAdapter } from "./production-operation.js";

it("plans from explicit roots without writes and applies managed profile and Terminal state without replacing foreign bytes", async () => {
  const releaseKey = "a".repeat(64), profile = "C:\\Users\\me\\.bashrc", terminal = "C:\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json";
  const files = new FakeBinaryFileSystem({ [profile]: Buffer.from("native\r\n") });
  const resources = new FakeJsonResourceStore({ [terminal]: { profiles: [{ guid: "foreign", name: "Keep" }], theme: "native" } });
  const adapter = new ProductionInstallerOperationAdapter({ MPX_APPS: "C:\\Apps", APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local", USERPROFILE: "C:\\Users\\me" }, "me", { files, resources });
  const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey, convergenceHash: releaseKey, components: ["cli"] };
  const manifest = { schemaVersion: 1, kind: "release-manifest", releaseKey, convergenceHash: releaseKey, files: [{ path: "bin/mpx.mjs", bytes: 3, sha256: "b".repeat(64) }] } as ReleaseManifestV1;
  const operations = await adapter.operations(intent, manifest);
  const selector = "C:\\Apps\\mpx\\bin\\mpx.cmd";
  expect(operations.automatic.map(item => item.id)).toContain("05-cli-selector");
  expect((await files.read(profile))?.toString()).toBe("native\r\n");
  expect(await resources.read(terminal)).toEqual({ profiles: [{ guid: "foreign", name: "Keep" }], theme: "native" });
  expect(operations.scheduled.map(x => x.id)).toEqual(["90-scheduled-capture"]);
  const task = operations.scheduled[0]!;
  expect(task.desiredDigest).not.toBeNull();
  for (const operation of operations.automatic.filter(x => x.id === "05-cli-selector" || x.id === "10-profile-0" || x.id === "20-terminal-profile")) await adapter.apply(operation);
  expect((await files.read(selector))?.toString()).toContain("active-release");
  expect((await files.read(profile))?.toString()).toContain("native\r\n# >>> MPX MANAGED LAUNCHERS >>>");
  expect(await resources.read(terminal)).toMatchObject({ profiles: [{ guid: "foreign", name: "Keep" }, { name: "MPX" }], theme: "native" });
  expect(operations.automatic.find(x => x.id === "20-terminal-profile")?.desiredDigest).toBe(installerDigest((await resources.read(terminal) as any).profiles[1]));
});
