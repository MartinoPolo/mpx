import { sha256Canonical, type JsonValue } from "@mpx/core";
import { parseF2ProofReportV1, type F2ProofReportV1 } from "@mpx/runtime-contracts";
import { ExecutionError, type ExecutorAdapter, type ProcessRequest, type ProcessResult, type VerificationEvidence } from "./index.js";
import type { SandboxLaunchPlanV1 } from "./sandbox-plan.js";
import { buildSbxCommandPlans } from "./sbx-plans.js";

export interface StandaloneSbxRunRequest {
  readonly executable:string; readonly argv:readonly string[]; readonly cwd:string;
  readonly environment:Readonly<Record<string,string>>; readonly signal?:AbortSignal;
}
export interface StandaloneSbxExecutorInput {
  readonly executable:string; readonly cwd:string; readonly plan:SandboxLaunchPlanV1; readonly agent:"claude"|"shell";
  readonly report:F2ProofReportV1; readonly sbxPinSha256:string; readonly executorEvidenceSha256:string;
  readonly ports:readonly string[];
  readonly worker?:{readonly argv:readonly string[];readonly endpoint:string;readonly attestationSha256:string};
  readonly diagnostics:()=>Promise<{readonly status:"pass"|"fail";readonly digest:string}>;
  readonly run:(request:StandaloneSbxRunRequest)=>Promise<ProcessResult>;
}
const SHA=/^[a-f0-9]{64}$/u;

/** Production adapter for the pinned standalone sbx command surface. It never invokes a shell. */
export class StandaloneSbxLifecycleAdapter implements ExecutorAdapter {
  readonly name="docker" as const;
  readonly bridge:{readonly endpoint:string;readonly attestationSha256:string}|undefined;
  constructor(readonly input:StandaloneSbxExecutorInput) {
    this.bridge=input.worker===undefined?undefined:Object.freeze({endpoint:input.worker.endpoint,attestationSha256:input.worker.attestationSha256});
  }
  async verify():Promise<VerificationEvidence>{
    try {
      const report=parseF2ProofReportV1(this.input.report),diagnostics=await this.input.diagnostics();
      const matches=diagnostics.status==="pass"&&SHA.test(diagnostics.digest)&&report.verdict==="pass"
        &&report.planKey===this.input.plan.planKey
        &&report.runtimeToolInventorySha256===this.input.plan.runtimeToolInventorySha256
        &&report.sbxPinSha256===this.input.sbxPinSha256
        &&report.executorEvidenceSha256===this.input.executorEvidenceSha256;
      return Object.freeze({status:matches?"verified":"unverified",verifier:"standalone-sbx-live",evidenceDigest:matches?report.reportKey:sha256Canonical({gate:"unverified",planKey:this.input.plan.planKey} as JsonValue)});
    } catch {
      return Object.freeze({status:"unverified",verifier:"standalone-sbx-live",evidenceDigest:sha256Canonical({gate:"invalid-proof",planKey:this.input.plan.planKey} as JsonValue)});
    }
  }
  async execute(request:ProcessRequest):Promise<ProcessResult>{
    const evidence=await this.verify();
    if(evidence.status!=="verified")throw new ExecutionError("EXECUTOR_GATE_UNVERIFIED","Docker execution requires a current matching live F2 proof report.");
    request.signal?.throwIfAborted();
    const commands=buildSbxCommandPlans(this.input.plan,{agent:this.input.agent,execArgv:[request.executable,...request.argv],ports:this.input.ports});
    const run=(argv:readonly string[])=>this.input.run({executable:this.input.executable,argv,cwd:this.input.cwd,environment:this.input.plan.environment,...(request.signal?{signal:request.signal}:{})});
    let created=false;
    try {
      const create=await run(commands.create);if(create.exitCode!==0)throw new ExecutionError("SBX_CREATE_FAILED","Standalone sbx create failed.");created=true;
      if(commands.ports.length>2){const ports=await run(commands.ports);if(ports.exitCode!==0)throw new ExecutionError("SBX_PORTS_FAILED","Standalone sbx port publication failed.");}
      const policy=await run(commands.policy);if(policy.exitCode!==0)throw new ExecutionError("SBX_POLICY_FAILED","Standalone sbx policy inspection failed.");
      if(this.input.worker){
        const workerCommands=buildSbxCommandPlans(this.input.plan,{agent:this.input.agent,execArgv:this.input.worker.argv,ports:[]});
        const worker=await run(workerCommands.exec);if(worker.exitCode!==0)throw new ExecutionError("SBX_WORKER_FAILED","Standalone sbx remote worker failed to start.");
      }
      return await run(commands.attach);
    } finally {
      if(created){const removed=await run(commands.delete);if(removed.exitCode!==0)throw new ExecutionError("SBX_TEARDOWN_FAILED","Standalone sbx teardown failed.");}
    }
  }
}

/** Executor-facing production name retained for callers; lifecycle behavior lives in the deep adapter above. */
export class StandaloneSbxExecutorAdapter extends StandaloneSbxLifecycleAdapter {}
