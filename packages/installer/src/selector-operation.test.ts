import { expect, it } from "vitest";
import { FakeBinaryFileSystem, FakeJsonResourceStore } from "@mpx/windows";
import type { InstallIntentV1, ReleaseManifestV1 } from "./immutable-core.js";
import { ProductionInstallerOperationAdapter } from "./production-operation.js";

it("owns the active-release selector inside the reversible operation set", async () => {
  const releaseKey = "a".repeat(64), files = new FakeBinaryFileSystem();
  const adapter = new ProductionInstallerOperationAdapter({ MPX_APPS: "C:\\Apps", APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local", USERPROFILE: "C:\\Users\\me" }, "me", { files, resources: new FakeJsonResourceStore() });
  const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey, convergenceHash: releaseKey, components: ["cli"] };
  const manifest = { schemaVersion: 1, kind: "release-manifest", releaseKey, convergenceHash: releaseKey, files: [{ path: "bin/mpx.mjs", bytes: 3, sha256: "b".repeat(64) }] } as ReleaseManifestV1;
  const operation = (await adapter.operations(intent, manifest)).automatic.find(item => item.id === "06-active-release")!;
  await adapter.apply(operation);
  expect((await files.read("C:\\Local\\mpx\\active-release"))?.toString()).toBe(`${releaseKey}\n`);
  await adapter.apply({ ...operation, action: "remove", desiredDigest: null });
  expect(await files.read("C:\\Local\\mpx\\active-release")).toBeUndefined();
});
