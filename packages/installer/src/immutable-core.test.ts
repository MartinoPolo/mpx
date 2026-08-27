import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NodeInstalledReleaseAuthority,
  activateRelease,
  buildReleaseManifest,
  installerDigest,
  parseOwnershipReceiptV1,
  parseReleaseManifestV1,
  publishRelease,
  readActiveRelease,
  type OwnershipReceiptV1,
} from "./immutable-core.js";

const temporary = () => mkdtemp(path.join(tmpdir(), "mpx-release-"));

describe("immutable installer core", () => {
  it("refuses foreign selector replacement and reversibly restores an owned prior selector", async () => {
    const root = await temporary(), prior = "a".repeat(64), activated = "b".repeat(64), foreign = "c".repeat(64);
    await mkdir(path.join(root, "mpx")); await writeFile(path.join(root, "mpx", "active-release"), `${foreign}\n`);
    await expect(activateRelease(root, prior, activated)).rejects.toMatchObject({ code: "INSTALL_FOREIGN_OR_DRIFTED" });
    expect(await readActiveRelease(root)).toBe(foreign);
    await writeFile(path.join(root, "mpx", "active-release"), `${prior}\n`);
    const rollback = await activateRelease(root, prior, activated);
    expect(await readActiveRelease(root)).toBe(activated);
    await rollback();
    expect(await readActiveRelease(root)).toBe(prior);
    const secondRollback = await activateRelease(root, prior, activated);
    await writeFile(path.join(root, "mpx", "active-release"), `${foreign}\n`);
    await expect(secondRollback()).rejects.toMatchObject({ code: "INSTALL_FOREIGN_OR_DRIFTED" });
    expect(await readActiveRelease(root)).toBe(foreign);
  });

  it("builds a deterministic, complete, sorted release manifest", async () => {
    const source = await temporary();
    await mkdir(path.join(source, "z"));
    await writeFile(path.join(source, "z", "b.txt"), "beta");
    await writeFile(path.join(source, "a.txt"), "alpha");
    const first = await buildReleaseManifest(source);
    const second = await buildReleaseManifest(source);
    expect(first).toEqual(second);
    expect(first.files.map((entry) => entry.path)).toEqual(["a.txt", "z/b.txt"]);
    expect(first.files.map((entry) => entry.bytes)).toEqual([5, 4]);
    expect(first.releaseKey).toBe(first.convergenceHash);
    expect(parseReleaseManifestV1(first)).toEqual(first);
  });

  it("rejects links instead of following them into a release", async () => {
    const source = await temporary();
    await writeFile(path.join(source, "file"), "safe");
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(source, "file"), path.join(source, "link"));
    await expect(buildReleaseManifest(source)).rejects.toMatchObject({ code: "INSTALL_RELEASE_UNSAFE_ENTRY" });
  });

  it("publishes atomically and never mutates an existing release", async () => {
    const source = await temporary(), apps = await temporary();
    await writeFile(path.join(source, "runner.js"), "one");
    const manifest = await publishRelease({ sourceDirectory: source, appsRoot: apps });
    const destination = path.join(apps, "mpx", "releases", manifest.releaseKey);
    await writeFile(path.join(source, "runner.js"), "two");
    await expect(publishRelease({ sourceDirectory: source, appsRoot: apps, releaseKey: manifest.releaseKey })).rejects.toMatchObject({ code: "INSTALL_RELEASE_KEY_MISMATCH" });
    expect(await readFile(path.join(destination, "runner.js"), "utf8")).toBe("one");
  });

  it("rejects forged operation locators whose immutable specification no longer matches its receipt binding", () => {
    const operation = { id: "owned", adapter: "files", action: "ensure" as const, target: "C:\\owned", desiredDigest: "b".repeat(64) }, spec = { kind: "file" };
    const receipt = { schemaVersion: 2, kind: "ownership-receipt", releaseKey: installerDigest([]), convergenceHash: installerDigest([]), files: [], operations: [operation], operationLocators: [{ operationId: operation.id, adapter: operation.adapter, spec, bindingDigest: installerDigest({ operation, spec }) }], installedAt: "2025-01-01T00:00:00.000Z" };
    expect(() => parseOwnershipReceiptV1({ ...receipt, operationLocators: [{ ...receipt.operationLocators[0], spec: { kind: "native" } }] })).toThrow(expect.objectContaining({ code: "INSTALL_SCHEMA_INVALID" }));
  });

  it("rejects legacy receipts whose removal operations have no durable locator", () => {
    const releaseKey = installerDigest([]);
    expect(() => parseOwnershipReceiptV1({ schemaVersion: 1, kind: "ownership-receipt", releaseKey, convergenceHash: releaseKey, files: [], operations: [{ id: "owned", adapter: "files", action: "ensure", target: "C:\\owned", desiredDigest: "b".repeat(64) }], installedAt: "2025-01-01T00:00:00.000Z" })).toThrow(expect.objectContaining({ code: "INSTALL_SCHEMA_INVALID" }));
  });

  it("authorizes only a receipt-bound regular release file immediately before use", async () => {
    const source = await temporary(), apps = await temporary();
    await writeFile(path.join(source, "runner.js"), "runner");
    const manifest = await publishRelease({ sourceDirectory: source, appsRoot: apps });
    const entry = manifest.files[0]!;
    const receipt: OwnershipReceiptV1 = { schemaVersion: 2, kind: "ownership-receipt", releaseKey: manifest.releaseKey, convergenceHash: manifest.convergenceHash, files: manifest.files, operations: [], operationLocators: [], installedAt: "2025-01-01T00:00:00.000Z" };
    const authority = new NodeInstalledReleaseAuthority({ appsRoot: apps, receipt: async () => receipt, prohibitedRoots: [] });
    const evidence = { path: path.join(apps, "mpx", "releases", manifest.releaseKey, entry.path), sha256: entry.sha256, bytes: entry.bytes, version: manifest.releaseKey };
    await expect(authority.verifyInstalled(evidence)).resolves.toMatchObject(evidence);
    await writeFile(evidence.path, "tampered");
    await expect(authority.verifyInstalled(evidence)).rejects.toMatchObject({ code: "INSTALL_RUNNER_STALE" });
    expect((await stat(evidence.path)).isFile()).toBe(true);
  });
});
