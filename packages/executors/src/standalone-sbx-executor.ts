import { createHash } from "node:crypto";
import path from "node:path";
import { sha256Canonical, type JsonValue } from "@mpx/core";
import { parseF2ProofReportV1, type F2ProofReportV1 } from "@mpx/runtime-contracts";
import { ExecutionError, type ExecutorAdapter, type ProcessRequest, type ProcessResult, type VerificationEvidence } from "./index.js";
import { PHASE_F2_REMOTE_TOOL_PATHS, attestRemoteToolSet, type ProductionRemoteToolClient, type RemoteToolSetAttestation } from "./production-remote.js";
import type { SandboxLaunchPlanV1 } from "./sandbox-plan.js";
import { buildSbxCommandPlans } from "./sbx-plans.js";

export interface StandaloneSbxRunRequest {
  readonly executable:string; readonly argv:readonly string[]; readonly cwd:string;
  readonly environment:Readonly<Record<string,string>>; readonly signal?:AbortSignal; readonly stdin?:Uint8Array;
}
export interface ClaudeCredentialAttestation {
  readonly appNamespace:string; readonly identity:string; readonly enrollmentSha256:string;
  readonly credentialIsolation:true; readonly oppositeIdentityDenied:true;
}
export interface ClaudeVmProjection {
  readonly archive:Uint8Array; readonly sha256:string; readonly pluginPath:string; readonly aggregateMcpPath:string;
  readonly remoteAttestation:RemoteToolSetAttestation;
}
export interface StandaloneSbxExecutorInput {
  readonly executable:string; readonly cwd:string; readonly plan:SandboxLaunchPlanV1; readonly agent:"claude"|"shell";
  readonly report:F2ProofReportV1; readonly sbxPinSha256:string; readonly executorEvidenceSha256:string;
  readonly ports:readonly string[];
  readonly worker?:{readonly argv:readonly string[];readonly endpoint:string;readonly attestationSha256:string};
  readonly remoteToolClient?:ProductionRemoteToolClient;
  readonly diagnostics:()=>Promise<{readonly status:"pass"|"fail";readonly digest:string}>;
  readonly credentialAttestation?:ClaudeCredentialAttestation; readonly projection?:ClaudeVmProjection;
  readonly run:(request:StandaloneSbxRunRequest)=>Promise<ProcessResult>;
}
const SHA=/^[a-f0-9]{64}$/u;

/** Production adapter for the pinned standalone sbx command surface. It never invokes a shell. */
export class StandaloneSbxLifecycleAdapter implements ExecutorAdapter {
  readonly name="docker" as const;
  readonly bridge:{readonly endpoint:string;readonly attestationSha256:string}|undefined;
  readonly remoteToolClient?:ProductionRemoteToolClient;
  constructor(readonly input:StandaloneSbxExecutorInput) {
    this.bridge=input.worker===undefined?undefined:Object.freeze({endpoint:input.worker.endpoint,attestationSha256:input.worker.attestationSha256});
    if(input.remoteToolClient)this.remoteToolClient=input.remoteToolClient;
  }
  async verify():Promise<VerificationEvidence>{
    try {
      const report=parseF2ProofReportV1(this.input.report),diagnostics=await this.input.diagnostics();
      const claudeRouteValid=this.input.agent!=="claude"||this.input.projection===undefined||this.#validateClaudeRoute();
      const matches=diagnostics.status==="pass"&&SHA.test(diagnostics.digest)&&report.verdict==="pass"
        &&report.planKey===this.input.plan.planKey
        &&report.runtimeToolInventorySha256===this.input.plan.runtimeToolInventorySha256
        &&report.sbxPinSha256===this.input.sbxPinSha256
        &&report.executorEvidenceSha256===this.input.executorEvidenceSha256&&claudeRouteValid;
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
    const scoped=(argv:readonly string[])=>["--app-name",this.input.plan.appNamespace,...argv] as const;
    const run=(argv:readonly string[],stdin?:Uint8Array)=>this.input.run({executable:this.input.executable,argv:scoped(argv),cwd:this.input.cwd,environment:this.input.plan.environment,...(request.signal?{signal:request.signal}:{}),...(stdin?{stdin}:{})});
    const productionClaude=this.input.agent==="claude"&&this.input.projection!==undefined;
    // Older proof-only fixtures use the unscoped lifecycle. Every production Claude
    // route is app-name scoped so Docker owns the selected identity's credential store.
    const lifecycleRun=(argv:readonly string[],stdin?:Uint8Array)=>productionClaude?run(argv,stdin):this.input.run({executable:this.input.executable,argv,cwd:this.input.cwd,environment:this.input.plan.environment,...(request.signal?{signal:request.signal}:{})});
    let created=false;
    try {
      const create=await lifecycleRun(commands.create);if(create.exitCode!==0)throw new ExecutionError("SBX_CREATE_FAILED","Standalone sbx create failed.");created=true;
      if(commands.ports.length>2){const ports=await lifecycleRun(commands.ports);if(ports.exitCode!==0)throw new ExecutionError("SBX_PORTS_FAILED","Standalone sbx port publication failed.");}
      const policy=await lifecycleRun(commands.policy);if(policy.exitCode!==0)throw new ExecutionError("SBX_POLICY_FAILED","Standalone sbx policy inspection failed.");
      if(this.input.worker){
        const workerCommands=buildSbxCommandPlans(this.input.plan,{agent:this.input.agent,execArgv:this.input.worker.argv,ports:[]});
        const worker=await lifecycleRun(workerCommands.exec);if(worker.exitCode!==0)throw new ExecutionError("SBX_WORKER_FAILED","Standalone sbx remote worker failed to start.");
      }
      if(!productionClaude)return await lifecycleRun(commands.attach);
      const projection=this.input.projection!;
      const root=`/opt/mpx/projections/${projection.sha256}`;
      const delivery=await lifecycleRun(["exec",this.input.plan.appName,"mpx-projection-receiver","--sha256",projection.sha256,"--destination",root],projection.archive);
      if(delivery.exitCode!==0)throw new ExecutionError("SBX_PROJECTION_DELIVERY_FAILED","Immutable MPX projection delivery failed.");
      const forwarded=this.#safeClaudeArgv(request.argv);
      return await lifecycleRun(["exec",this.input.plan.appName,"claude","--plugin-dir",path.posix.join(root,projection.pluginPath),"--mcp-config",path.posix.join(root,projection.aggregateMcpPath),...forwarded]);
    } finally {
      if(created){const removed=await lifecycleRun(commands.delete);if(removed.exitCode!==0)throw new ExecutionError("SBX_TEARDOWN_FAILED","Standalone sbx teardown failed.");}
    }
  }
  #validateClaudeRoute():boolean {
    const credential=this.input.credentialAttestation,projection=this.input.projection;
    if(!credential||!projection)return false;
    const digest=createHash("sha256").update(projection.archive).digest("hex");
    const safeRelative=(value:string)=>value.length>0&&!path.posix.isAbsolute(value)&&!value.split("/").includes("..")&&!/[\\\r\n\0]/u.test(value);
    return this.input.plan.credentialProofRequirements?.provider==="sbx-built-in"
      &&credential.appNamespace===this.input.plan.appNamespace&&credential.identity===this.input.plan.appNamespace.replace(/^mpx-claude-/u,"")
      &&SHA.test(credential.enrollmentSha256)&&credential.credentialIsolation===true&&credential.oppositeIdentityDenied===true
      &&projection.sha256===digest&&safeRelative(projection.pluginPath)&&safeRelative(projection.aggregateMcpPath)
      &&attestRemoteToolSet(projection.remoteAttestation,PHASE_F2_REMOTE_TOOL_PATHS,this.input.plan.runtimeToolInventorySha256);
  }
  #safeClaudeArgv(argv:readonly string[]):readonly string[]{
    if(argv.some(value=>!value||value.length>8192||/[\r\n\0]/u.test(value)||/CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|claude-gateway|apps[\\/]cli/iu.test(value)))throw new ExecutionError("SBX_CLAUDE_ARGV_INVALID","Claude sandbox argv contains a host-only or private route.");
    if(argv.some(value=>value==="--plugin-dir"||value==="--mcp-config"))throw new ExecutionError("SBX_CLAUDE_ARGV_INVALID","Projection and aggregate service routes are owned by the sandbox adapter.");
    return Object.freeze([...argv]);
  }
}

/** Executor-facing production name retained for callers; lifecycle behavior lives in the deep adapter above. */
export class StandaloneSbxExecutorAdapter extends StandaloneSbxLifecycleAdapter {}
