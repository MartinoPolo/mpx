import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MpxError } from "@mpx/core";
import {
  buildCurrentReleaseManifest,
  canonicalJson,
  parseInstallIntentV1,
  parseInstallPlanV1,
  publishCurrentRelease,
  type CurrentReleaseOptions,
  type InstallIntentV1,
  type InstallOperationV1,
  type InstallPlanV1,
  type InstallOperationClassificationsV1,
  type InstallVerificationV1,
  type OwnershipReceiptV1,
  type ReleaseManifestV1,
} from "./immutable-core.js";
import { ImmutableInstallerService, installerDigest, type SideEffectAdapter, type TransactionStore } from "./transaction.js";

function fail(code: string, message: string): never { throw new MpxError({ code, message }); }
const missing = (failure: unknown): boolean => (failure as NodeJS.ErrnoException).code === "ENOENT";

export interface InstallerOperationSet {
  readonly automatic: readonly InstallOperationV1[];
  readonly scheduled: readonly InstallOperationV1[];
  readonly classifications?: InstallOperationClassificationsV1;
}
/** The host owns native details; orchestration only consumes ordered, reversible operations. */
export interface InstallerOperationAdapter extends SideEffectAdapter {
  operations(intent: InstallIntentV1, manifest: ReleaseManifestV1): Promise<InstallerOperationSet>;
}
export interface CurrentReleaseBuilder {
  readonly appsRoot: string;
  build(): Promise<ReleaseManifestV1>;
  publish(expectedReleaseKey: string): Promise<ReleaseManifestV1>;
  verify(receipt: OwnershipReceiptV1, strict: boolean): Promise<readonly string[]>;
}

async function walkRelative(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const names = await readdir(directory);
  const result: string[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const next = relative ? `${relative}/${name}` : name;
    const info = await lstat(path.join(root, ...next.split("/")));
    if (info.isDirectory() && !info.isSymbolicLink()) result.push(...await walkRelative(root, next));
    else result.push(next);
  }
  return result;
}

export class NodeCurrentReleaseBuilder implements CurrentReleaseBuilder {
  readonly appsRoot: string;
  private readonly current: CurrentReleaseOptions;
  constructor(options: CurrentReleaseOptions & { readonly appsRoot: string }) {
    this.appsRoot = options.appsRoot;
    this.current = { repositoryRoot: options.repositoryRoot, ...(options.assetPaths ? { assetPaths: options.assetPaths } : {}) };
  }
  build(): Promise<ReleaseManifestV1> { return buildCurrentReleaseManifest(this.current); }
  async publish(expectedReleaseKey: string): Promise<ReleaseManifestV1> {
    const manifest = await publishCurrentRelease({ ...this.current, appsRoot: this.appsRoot });
    if (manifest.releaseKey !== expectedReleaseKey) fail("INSTALL_PLAN_STALE", "Current release changed after planning.");
    return manifest;
  }
  async verify(receipt: OwnershipReceiptV1, strict: boolean): Promise<readonly string[]> {
    const root = path.join(this.appsRoot, "mpx", "releases", receipt.releaseKey), issues: string[] = [];
    const expectedManifest = canonicalJson({ schemaVersion: 1, kind: "release-manifest", releaseKey: receipt.releaseKey, convergenceHash: receipt.convergenceHash, files: receipt.files });
    try {
      const manifestInfo = await lstat(path.join(root, "release-manifest.json"));
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || (await readFile(path.join(root, "release-manifest.json"), "utf8")).trim() !== expectedManifest) issues.push("release-manifest-drift");
    } catch (failure) { if (missing(failure)) issues.push("release-manifest-missing"); else throw failure; }
    for (const file of receipt.files) {
      const absolute = path.join(root, ...file.path.split("/"));
      try {
        const info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) { issues.push(`release-file-drift:${file.path}`); continue; }
        const actual = createHash("sha256").update(await readFile(absolute)).digest("hex");
        if (actual !== file.sha256) issues.push(`release-file-drift:${file.path}`);
      } catch (failure) { if (missing(failure)) issues.push(`release-file-missing:${file.path}`); else throw failure; }
    }
    if (strict) {
      let actual: string[] = [];
      try { actual = await walkRelative(root); } catch (failure) { if (!missing(failure)) throw failure; }
      const owned = new Set([...receipt.files.map(file => file.path), "release-manifest.json"]);
      for (const entry of actual) if (!owned.has(entry)) issues.push(`foreign-release-entry:${entry}`);
    }
    return issues.sort((a, b) => a.localeCompare(b));
  }
}

export interface InstallOrchestratorOptions {
  readonly adapter: InstallerOperationAdapter;
  readonly store: TransactionStore;
  readonly releases: CurrentReleaseBuilder;
  /** Publishes the mutable stable selector after all release-bound operations commit. */
  readonly activate?: (releaseKey: string) => Promise<void>;
  /** Removes the mutable stable selector only after owned resources uninstall. */
  readonly deactivate?: (releaseKey: string) => Promise<void>;
  readonly now?: () => Date;
}
export interface RollbackResultV1 { readonly schemaVersion: 1; readonly kind: "install-rollback"; readonly transactionId: string; readonly rolledBack: true }
export interface UninstallResultV1 { readonly schemaVersion: 1; readonly kind: "install-uninstall"; readonly releaseKey: string; readonly removed: true }

export class InstallOrchestrator {
  private readonly now: () => Date;
  constructor(private readonly options: InstallOrchestratorOptions) { this.now = options.now ?? (() => new Date()); }
  private service(manifest?: ReleaseManifestV1): ImmutableInstallerService {
    return new ImmutableInstallerService({ adapters: [this.options.adapter], store: this.options.store, ...(manifest ? { manifest } : {}), now: this.now });
  }
  private async current(intentValue: InstallIntentV1): Promise<{ intent: InstallIntentV1; manifest: ReleaseManifestV1; operations: readonly InstallOperationV1[]; classifications?: InstallOperationClassificationsV1 }> {
    const intent = parseInstallIntentV1(intentValue), manifest = await this.options.releases.build();
    if (intent.releaseKey !== manifest.releaseKey || intent.convergenceHash !== manifest.convergenceHash) fail("INSTALL_INTENT_STALE", "Intent does not describe the current deterministic release.");
    const grouped = await this.options.adapter.operations(intent, manifest);
    const automatic = [...grouped.automatic].sort((a, b) => a.id.localeCompare(b.id));
    const scheduled = [...grouped.scheduled].sort((a, b) => a.id.localeCompare(b.id));
    const operations = [...automatic, ...scheduled];
    if (new Set(operations.map(operation => operation.id)).size !== operations.length) fail("INSTALL_OPERATION_DUPLICATE", "Operation IDs must be unique.");
    if (operations.some((operation, index) => index > 0 && operations[index - 1]!.id.localeCompare(operation.id) >= 0)) fail("INSTALL_OPERATION_ORDER_INVALID", "Automatic operations must sort before scheduled operations.");
    return { intent, manifest, operations, ...(grouped.classifications ? { classifications: grouped.classifications } : {}) };
  }
  async plan(intent: InstallIntentV1): Promise<InstallPlanV1> {
    const current = await this.current(intent);
    const base = await this.service(current.manifest).plan(current.intent, current.operations);
    if (!current.classifications) return base;
    const classified = { schemaVersion: base.schemaVersion, kind: base.kind, intent: base.intent, observations: base.observations, operations: base.operations, classifications: current.classifications };
    return parseInstallPlanV1({ ...classified, confirmationDigest: installerDigest(classified) });
  }
  async apply(planValue: InstallPlanV1, confirmation: string): Promise<OwnershipReceiptV1> {
    const plan = parseInstallPlanV1(planValue);
    if (confirmation !== plan.confirmationDigest) fail("INSTALL_CONFIRMATION_MISMATCH", "Exact plan confirmation is required.");
    const current = await this.current(plan.intent);
    if (installerDigest(current.operations) !== installerDigest(plan.operations) || installerDigest(current.classifications ?? null) !== installerDigest(plan.classifications ?? null)) fail("INSTALL_PLAN_STALE", "Install operations changed after planning.");
    const revalidated = await this.service(current.manifest).plan(current.intent, current.operations);
    if (installerDigest(revalidated.observations) !== installerDigest(plan.observations)) fail("INSTALL_OBSERVATION_CHANGED", "Machine observations changed after planning.");
    if (plan.operations.some((operation, index) => operation.action === "ensure" && plan.observations[index]?.digest !== null && plan.observations[index]?.digest !== operation.desiredDigest))
      fail("INSTALL_FOREIGN_OR_DRIFTED", "Refusing to overwrite a foreign or drifted target.");
    const manifest = await this.options.releases.publish(plan.intent.releaseKey);
    const service = this.service(manifest);
    const receipt = await service.apply(plan, confirmation);
    const operationVerification = await service.verify();
    const releaseIssues = await this.options.releases.verify(receipt, false);
    if (!operationVerification.healthy || releaseIssues.length > 0) fail("INSTALL_POST_COMMIT_VERIFY_FAILED", "Committed installation failed actual-state verification; release was not activated.");
    await this.options.activate?.(receipt.releaseKey);
    return receipt;
  }
  async verify(strict = false): Promise<InstallVerificationV1> {
    const receipt = await this.options.store.readReceipt();
    if (receipt) {
      const manifest: ReleaseManifestV1 = { schemaVersion: 1, kind: "release-manifest", releaseKey: receipt.releaseKey, convergenceHash: receipt.convergenceHash, files: receipt.files };
      await this.options.adapter.operations(receipt.installIntent ?? { schemaVersion: 1, kind: "install-intent", releaseKey: receipt.releaseKey, convergenceHash: receipt.convergenceHash, components: ["verify"] }, manifest);
    }
    const base = await this.service().verify();
    const issues = [...base.issues, ...(receipt ? await this.options.releases.verify(receipt, strict) : [])].sort((a, b) => a.localeCompare(b));
    if (!receipt?.installIntent) return { ...base, healthy: issues.length === 0, issues };
    const runtimeIds = receipt.installIntent.runtimeRegistrations?.registrations.map(registration => registration.identity) ?? [];
    const components = ["system", ...runtimeIds].map(id => ({ id, automatic: true as const, status: issues.some(issue => id === "system" ? !issue.includes("registration-") && !runtimeIds.some(runtimeId => issue.includes(runtimeId)) : issue.includes(id)) ? "unhealthy" as const : "actual-state-verified" as const }));
    const externalIntegrations = (receipt.installIntent.externalIntegrations ?? []).map(integration => ({ id: integration.id, classification: integration.classification, status: integration.classification === "manual-only" ? "manual-required" as const : "confirmed" as const, verifierRef: integration.verifierRef ?? `${integration.adapter}:${integration.id}` }));
    return { ...base, healthy: issues.length === 0, issues, components, externalIntegrations, manualOnly: externalIntegrations.filter(item => item.classification === "manual-only").map(item => item.id) };
  }
  async rollback(transactionId: string, confirmation: string): Promise<RollbackResultV1> {
    const stored = await this.options.store.readTransaction();
    if (!stored || stored.journal.transactionId !== transactionId) fail("INSTALL_TRANSACTION_UNAVAILABLE", "Transaction is unavailable.");
    if (confirmation !== installerDigest(stored.journal.snapshot)) fail("INSTALL_CONFIRMATION_MISMATCH", "Exact transaction confirmation is required.");
    await this.service().rollback();
    return { schemaVersion: 1, kind: "install-rollback", transactionId, rolledBack: true };
  }
  async planUninstall(): Promise<InstallPlanV1> { return this.service().planUninstall(); }
  async uninstall(confirmation: string): Promise<UninstallResultV1> {
    const plan = await this.planUninstall();
    await this.service().uninstall(plan, confirmation);
    await this.options.deactivate?.(plan.intent.releaseKey);
    return { schemaVersion: 1, kind: "install-uninstall", releaseKey: plan.intent.releaseKey, removed: true };
  }
}
