import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createF2ProofReportV1,
  createSandboxPlanV1,
  parseRemoteToolRequestV1,
  parseSandboxPlanV1,
  parseSbxPinV1,
  validateF2ProofReportV1,
} from "../src/index.js";

const h = (character: string) => character.repeat(64);
const pin = {
  schemaVersion: 1,
  product: "docker-sbx-standalone",
  version: "0.39.0",
  buildCommit: "def8cb0523a77e757bdd6ef52b459fe374f3783e",
  releaseCommit: "bdfd32bd69bb084959b5f4779310bff21d95bb62",
  contribReviewCommit: "cc502cd9b689ccbcade7f80de2c2660dae03d6aa",
  windowsBinarySha256: "b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf",
  reviewedArtifactSha256: { license: h("a"), features: h("b"), commands: h("c") },
  rejectedIntegrations: ["contrib-pi-kit", "legacy-docker-sandbox"],
} as const;

describe("Phase F2 proof contracts", () => {
  it("parses the standalone sbx pin and rejects legacy integration substitutions", () => {
    expect(parseSbxPinV1(pin)).toEqual(pin);
    expect(() => parseSbxPinV1({ ...pin, product: "legacy-docker-sandbox" })).toThrow(/SBX_PIN_INVALID/u);
    expect(() => parseSbxPinV1({ ...pin, rejectedIntegrations: ["legacy-docker-sandbox"] })).toThrow(/SBX_PIN_INVALID/u);
  });

  it("rejects unknown, oversized, and privacy-bearing fields at proof boundaries", () => {
    expect(() => parseRemoteToolRequestV1({ schemaVersion: 1, requestId: "r", toolPath: "mcp/chrome/call", inputSha256: h("a"), prompt: "steal me" })).toThrow(/UNKNOWN_FIELD/u);
    expect(() => parseRemoteToolRequestV1({ schemaVersion: 1, requestId: "r", toolPath: `mcp/${"x".repeat(300)}`, inputSha256: h("a") })).toThrow(/INVALID_CONTRACT/u);
    expect(() => parseSandboxPlanV1({ schemaVersion: 1, planKey: h("a"), runtime: "pi", sbxPinSha256: h("b"), runtimeToolInventorySha256: h("c"), executorEvidenceSha256: h("d"), networkPolicy: "deny-by-default", workspaceReference: "C:/Users/alice/project" })).toThrow(/PRIVATE_DATA/u);
  });

  it("publishes closed JSON schemas for every v1 proof contract", async () => {
    const schema = JSON.parse(await readFile(fileURLToPath(new URL("../schemas/f2-proof-contracts-v1.schema.json", import.meta.url)), "utf8"));
    const names = ["SbxPinV1", "SbxDiagnosticsV1", "SandboxPlanV1", "SandboxAttestationV1", "RemoteToolRequestV1", "RemoteToolResultV1", "SandboxResumeTokenV1", "BuiltInClaudeIdentityEvidenceV1", "BuiltInClaudeEvidenceV1", "F2ProofReportV1"];
    expect(names.every(name => schema.$defs[name].additionalProperties === false)).toBe(true);
  });

  it("invalidates proof whenever runtime tool inventory drifts", () => {
    const plan = createSandboxPlanV1({ runtime: "pi", sbxPinSha256: h("a"), runtimeToolInventorySha256: h("b"), executorEvidenceSha256: h("c"), networkPolicy: "deny-by-default", workspaceReference: "worktree" });
    const report = createF2ProofReportV1({ planKey: plan.planKey, sbxPinSha256: h("a"), runtimeToolInventorySha256: h("b"), executorEvidenceSha256: h("c"), attestationSha256: h("d"), verdict: "pass" });
    expect(validateF2ProofReportV1(report, { runtimeToolInventorySha256: h("b"), executorEvidenceSha256: h("c") }).valid).toBe(true);
    expect(validateF2ProofReportV1(report, { runtimeToolInventorySha256: h("e"), executorEvidenceSha256: h("c") })).toMatchObject({ valid: false, diagnostics: [{ code: "RUNTIME_TOOL_INVENTORY_DRIFT" }] });
  });

  it("binds independently captured built-in Claude evidence for both identities into the report key", () => {
    const builtInClaudeEvidence={source:"signed-fixture" as const,identities:[
      {identity:"personal" as const,appNamespace:"mpx-claude-personal",enrollmentEvidenceSha256:h("1"),isolationEvidenceSha256:h("2"),oppositeIdentityDenialEvidenceSha256:h("3"),captureSignatureSha256:h("4")},
      {identity:"work" as const,appNamespace:"mpx-claude-work",enrollmentEvidenceSha256:h("5"),isolationEvidenceSha256:h("6"),oppositeIdentityDenialEvidenceSha256:h("7"),captureSignatureSha256:h("8")},
    ] as const};
    const report=createF2ProofReportV1({planKey:h("a"),sbxPinSha256:h("b"),runtimeToolInventorySha256:h("c"),executorEvidenceSha256:h("d"),attestationSha256:h("e"),builtInClaudeEvidence,verdict:"pass"});
    expect(report.builtInClaudeEvidence).toEqual(builtInClaudeEvidence);
    expect(()=>createF2ProofReportV1({...report,builtInClaudeEvidence:{...builtInClaudeEvidence,identities:[builtInClaudeEvidence.identities[0],builtInClaudeEvidence.identities[0]]} as never})).toThrow(/identities/iu);
  });
});
