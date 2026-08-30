import { createF2ProofReportV1, f2Sha256, type F2ProofReportV1 } from "@mpx/runtime-contracts";
import { ExecutionError } from "./index.js";
const SHA=/^[a-f0-9]{64}$/u;
export async function runFakeSbxProof(input:{planKey:string;sbxPinSha256:string;runtimeToolInventorySha256:string;executorEvidenceSha256:string;invoke(argv:readonly string[]):Promise<{exitCode:number;stdout:string;stderr:string}>}):Promise<F2ProofReportV1>{
 for(const value of [input.planKey,input.sbxPinSha256,input.runtimeToolInventorySha256,input.executorEvidenceSha256])if(!SHA.test(value))throw new ExecutionError("PROOF_INPUT_INVALID","Proof digest is invalid.");
 const transcript:unknown[]=[];for(const argv of [["version"],["create","--name","mpx-proof","shell","/workspace"],["policy","check","network","--sandbox","mpx-proof","blocked.invalid:443","--json"],["rm","--force","mpx-proof"]]){const result=await input.invoke(argv);transcript.push({argv,exitCode:result.exitCode,stdoutSha256:f2Sha256(result.stdout),stderrSha256:f2Sha256(result.stderr)});if(result.exitCode!==0)throw new ExecutionError("FAKE_SBX_PROOF_FAILED","Fake sbx proof command failed.")}
 const attestationSha256=f2Sha256({schemaVersion:1,kind:"fake-sbx-proof",transcript});return createF2ProofReportV1({planKey:input.planKey,sbxPinSha256:input.sbxPinSha256,runtimeToolInventorySha256:input.runtimeToolInventorySha256,executorEvidenceSha256:input.executorEvidenceSha256,attestationSha256,verdict:"pass"});
}
