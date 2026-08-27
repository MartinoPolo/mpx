import { expect, it } from "vitest";
import { FakeBinaryFileSystem, FakeJsonResourceStore } from "@mpx/windows";
import { installerDigest, type InstallIntentV1, type ReleaseManifestV1 } from "./immutable-core.js";
import { ProductionInstallerOperationAdapter } from "./production-operation.js";

it("keeps concurrent plans bound to their own roots and resources", async () => {
  const firstKey = "a".repeat(64), secondKey = "c".repeat(64), files = new FakeBinaryFileSystem(), resources = new FakeJsonResourceStore();
  const adapter = new ProductionInstallerOperationAdapter({ MPX_APPS: "C:\\Apps-A", APPDATA: "C:\\Roaming-A", LOCALAPPDATA: "C:\\Local-A", USERPROFILE: "C:\\Users\\a" }, "me", { files, resources });
  const intent = (releaseKey: string): InstallIntentV1 => ({ schemaVersion: 1, kind: "install-intent", releaseKey, convergenceHash: releaseKey, components: ["cli"] });
  const manifest = (releaseKey: string, cliSha: string): ReleaseManifestV1 => ({ schemaVersion: 1, kind: "release-manifest", releaseKey, convergenceHash: releaseKey, files: [{ path: "bin/mpx.mjs", bytes: 3, sha256: cliSha }] });
  const first = await adapter.operations(intent(firstKey), manifest(firstKey, "b".repeat(64)));
  Object.assign((adapter as unknown as { environment: NodeJS.ProcessEnv }).environment, { MPX_APPS: "C:\\Apps-B", APPDATA: "C:\\Roaming-B", LOCALAPPDATA: "C:\\Local-B", USERPROFILE: "C:\\Users\\b" });
  const second = await adapter.operations(intent(secondKey), manifest(secondKey, "d".repeat(64)));
  const selected = (set: Awaited<ReturnType<typeof adapter.operations>>) => set.automatic.filter(operation => ["05-cli-selector", "10-profile-0", "20-terminal-profile"].includes(operation.id));
  await Promise.all([...selected(first), ...selected(second)].map(operation => adapter.apply(operation)));
  expect((await files.read("C:\\Apps-A\\mpx\\bin\\mpx.cmd"))?.toString()).toContain("active-release");
  expect((await files.read("C:\\Apps-B\\mpx\\bin\\mpx.cmd"))?.toString()).toContain("active-release");
  expect(await resources.read("C:\\Local-A\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json")).toMatchObject({ profiles: [{ name: "MPX" }] });
  expect(await resources.read("C:\\Local-B\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json")).toMatchObject({ profiles: [{ name: "MPX" }] });
});

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
