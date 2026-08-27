import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { MpxError, parseStrictJson } from "@mpx/core";
import { canonicalJson, parseReleaseManifestV1, readActiveRelease, type ReleaseManifestV1 } from "./immutable-core.js";
import type { TransactionStore } from "./transaction.js";
import type { ImmutableRunnerAuthority, InstalledRunnerEvidence } from "./index.js";

function unavailable(message: string, status: "uninstalled" | "unavailable" = "unavailable"): never {
  throw new MpxError({ code: "INSTALL_RUNNER_UNAVAILABLE", message, details: { status } });
}
function stale(message: string): never { throw new MpxError({ code: "INSTALL_RUNNER_STALE", message }); }
const missing = (failure: unknown): boolean => (failure as NodeJS.ErrnoException).code === "ENOENT";

export interface NodeInstalledRunnerAuthorityOptions {
  readonly appsRoot: string;
  readonly localAppData: string;
  readonly store: TransactionStore;
  readonly runnerRelativePath?: string;
}

/** Resolves runner authority from the active immutable selector, release manifest, and ownership receipt. */
export class NodeInstalledRunnerAuthority implements ImmutableRunnerAuthority {
  private readonly runnerRelativePath: string;
  constructor(private readonly options: NodeInstalledRunnerAuthorityOptions) {
    this.runnerRelativePath = options.runnerRelativePath ?? "bin/mpx.mjs";
  }
  private async active(): Promise<{ manifest: ReleaseManifestV1; evidence: InstalledRunnerEvidence }> {
    let releaseKey: string;
    try { releaseKey = await readActiveRelease(this.options.localAppData); }
    catch (failure) { if ((failure as { code?: unknown }).code === "INSTALL_SELECTOR_UNAVAILABLE" || missing(failure)) unavailable("The immutable MPX runner is not installed.", "uninstalled"); throw failure; }
    const receipt = await this.options.store.readReceipt();
    if (!receipt) unavailable("The active immutable MPX release has no ownership receipt.", "uninstalled");
    if (receipt.releaseKey !== releaseKey) unavailable("The active immutable MPX release is not receipt-bound.");
    const releaseRoot = path.join(this.options.appsRoot, "mpx", "releases", releaseKey);
    const manifestPath = path.join(releaseRoot, "release-manifest.json");
    let manifest: ReleaseManifestV1;
    try {
      const info = await lstat(manifestPath);
      if (!info.isFile() || info.isSymbolicLink()) unavailable("The active immutable release manifest is unsafe.");
      manifest = parseReleaseManifestV1(parseStrictJson(await readFile(manifestPath, "utf8")));
    } catch (failure) { if (failure instanceof MpxError) throw failure; if (missing(failure)) unavailable("The active immutable release manifest is unavailable."); throw failure; }
    const receiptManifest = { schemaVersion: 1 as const, kind: "release-manifest" as const, releaseKey: receipt.releaseKey, convergenceHash: receipt.convergenceHash, files: receipt.files };
    if (manifest.releaseKey !== releaseKey || canonicalJson(manifest) !== canonicalJson(receiptManifest)) stale("The active immutable release manifest does not match its receipt.");
    const file = manifest.files.find(candidate => candidate.path === this.runnerRelativePath);
    if (!file) unavailable("The active immutable release has no installed runner.");
    return { manifest, evidence: { path: path.join(releaseRoot, ...file.path.split("/")), sha256: file.sha256, version: releaseKey } };
  }
  async resolveInstalled(): Promise<InstalledRunnerEvidence> {
    const { evidence } = await this.active();
    return this.verifyInstalled(evidence);
  }
  async verifyInstalled(evidence: InstalledRunnerEvidence): Promise<InstalledRunnerEvidence> {
    const active = await this.active();
    if (canonicalJson(active.evidence) !== canonicalJson(evidence)) stale("Runner evidence is not the active immutable release runner.");
    let linkInfo;
    try { linkInfo = await lstat(evidence.path); } catch (failure) { if (missing(failure)) unavailable("The active immutable runner file is unavailable."); throw failure; }
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) unavailable("The active immutable runner file is unsafe.");
    const expected = active.manifest.files.find(candidate => candidate.path === this.runnerRelativePath)!;
    const handle = await open(evidence.path, "r").catch((failure) => { if (missing(failure)) unavailable("The active immutable runner file is unavailable."); throw failure; });
    try {
      const info = await handle.stat();
      if (!info.isFile()) unavailable("The active immutable runner file is unsafe.");
      if (info.size !== expected.bytes) stale("The active immutable runner file size changed.");
      const actual = createHash("sha256").update(await handle.readFile()).digest("hex");
      if (actual !== evidence.sha256) stale("The active immutable runner file was tampered with.");
      return evidence;
    } finally { await handle.close(); }
  }
}
