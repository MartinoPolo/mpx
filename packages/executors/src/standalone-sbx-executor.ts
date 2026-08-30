import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sha256Canonical, type JsonValue } from "@mpx/core";
import { f2Sha256, parseF2ProofReportV1, parseF2ProofReportV2, validateF2ProofReportV2, type BuiltInClaudeEvidenceV1, type F2ProofReportV1, type F2ProofReportV2, type SbxLaunchPlanExportV1 } from "@mpx/runtime-contracts";
import { ExecutionError, type ExecutorAdapter, type ProcessRequest, type ProcessResult, type VerificationEvidence } from "./index.js";
import { PHASE_F2_REMOTE_TOOL_PATHS, attestRemoteToolSet, type ProductionRemoteToolClient, type RemoteToolSetAttestation } from "./production-remote.js";
import type { SandboxLaunchPlanV1 } from "./sandbox-plan.js";
import { buildSbxCommandPlans } from "./sbx-plans.js";
import { parsePolicyEvidence } from "./sbx-policy.js";

export interface StandaloneSbxRunRequest {
  readonly executable:string; readonly argv:readonly string[]; readonly cwd:string;
  readonly environment:Readonly<Record<string,string>>; readonly signal?:AbortSignal; readonly stdin?:Uint8Array;
}
export interface ClaudeVmProjection {
  readonly archive:Uint8Array; readonly sha256:string; readonly pluginPath:string; readonly aggregateMcpPath:string;
  readonly remoteAttestation:RemoteToolSetAttestation;
}
export interface StandaloneSbxExecutorInput {
  readonly executable:string; readonly cwd:string; readonly plan:SandboxLaunchPlanV1; readonly agent:"claude"|"shell";
  readonly report:F2ProofReportV1|F2ProofReportV2; readonly planExport?:SbxLaunchPlanExportV1; readonly sbxPinSha256:string; readonly executorEvidenceSha256:string;
  readonly ports:readonly string[];
  readonly worker?:{readonly argv:readonly string[];readonly endpoint:string;readonly attestationSha256:string};
  readonly remoteToolClient?:ProductionRemoteToolClient;
  readonly diagnostics:()=>Promise<{readonly status:"pass"|"fail";readonly digest:string}>;
  readonly claudeEvidence?:BuiltInClaudeEvidenceV1; readonly allowSignedFixtureEvidence?:boolean; readonly projection?:ClaudeVmProjection;
  readonly run:(request:StandaloneSbxRunRequest)=>Promise<ProcessResult>;
}
const SHA=/^[a-f0-9]{64}$/u;

/** Production adapter for the pinned standalone sbx command surface. It never invokes a shell. */
export class StandaloneSbxLifecycleAdapter implements ExecutorAdapter {
  readonly name="docker" as const;
  readonly proofLaunchKey?:string;
  readonly bridge:{readonly endpoint:string;readonly attestationSha256:string}|undefined;
  readonly remoteToolClient?:ProductionRemoteToolClient;
  #resumeAction:"attach"|"recreate"|undefined;
  #projection:ClaudeVmProjection|undefined;
  constructor(readonly input:StandaloneSbxExecutorInput) {
    this.#projection=input.projection;
    if(input.planExport)this.proofLaunchKey=input.planExport.launchKey;
    this.bridge=input.worker===undefined?undefined:Object.freeze({endpoint:input.worker.endpoint,attestationSha256:input.worker.attestationSha256});
    if(input.remoteToolClient)this.remoteToolClient=input.remoteToolClient;
  }
  setResumeAction(action:"attach"|"recreate"):void{this.#resumeAction=action;}
  async verify():Promise<VerificationEvidence>{
    try {
      const report=this.input.planExport===undefined?parseF2ProofReportV1(this.input.report):parseF2ProofReportV2(this.input.report),diagnostics=await this.input.diagnostics();
      const exportValid=this.input.planExport===undefined||validateF2ProofReportV2(report,this.input.planExport).valid;
      const claudeEvidenceValid=this.input.agent!=="claude"||this.#resumeAction==="attach"||this.#validateClaudeEvidence(report);
      const claudeRouteValid=this.input.agent!=="claude"||this.#resumeAction==="attach"||this.#projection===undefined||this.#validateClaudeRoute();
      const planKey="planKey" in report?report.planKey:report.sandbox.planKey,evidence="evidence" in report?report.evidence:report;
      const matches=diagnostics.status==="pass"&&SHA.test(diagnostics.digest)&&report.verdict==="pass"&&exportValid
        &&planKey===this.input.plan.planKey
        &&evidence.runtimeToolInventorySha256===this.input.plan.runtimeToolInventorySha256
        &&evidence.sbxPinSha256===this.input.sbxPinSha256
        &&evidence.executorEvidenceSha256===this.input.executorEvidenceSha256&&claudeEvidenceValid&&claudeRouteValid;
      return Object.freeze({status:matches?"verified":"unverified",verifier:"standalone-sbx-live",evidenceDigest:matches?report.reportKey:sha256Canonical({gate:"unverified",planKey:this.input.plan.planKey} as JsonValue)});
    } catch {
      return Object.freeze({status:"unverified",verifier:"standalone-sbx-live",evidenceDigest:sha256Canonical({gate:"invalid-proof",planKey:this.input.plan.planKey} as JsonValue)});
    }
  }
  async execute(request:ProcessRequest):Promise<ProcessResult>{
    let evidence=await this.verify();
    if(evidence.status!=="verified")throw new ExecutionError("EXECUTOR_GATE_UNVERIFIED","Docker execution requires a current matching live F2 proof report.");
    if(this.input.agent==="claude"&&this.#resumeAction!=="attach"&&this.#projection===undefined){await this.#bindClaudeLaunch(request);evidence=await this.verify();}
    if(evidence.status!=="verified")throw new ExecutionError("EXECUTOR_GATE_UNVERIFIED","Docker execution requires a current matching live F2 proof report.");
    request.signal?.throwIfAborted();
    const commands=buildSbxCommandPlans(this.input.plan,{agent:this.input.agent,execArgv:[request.executable,...request.argv],ports:this.input.ports});
    const scoped=(argv:readonly string[])=>["--app-name",this.input.plan.appNamespace,...argv] as const;
    const run=(argv:readonly string[],stdin?:Uint8Array)=>this.input.run({executable:this.input.executable,argv:scoped(argv),cwd:this.input.cwd,environment:this.input.plan.environment,...(request.signal?{signal:request.signal}:{}),...(stdin?{stdin}:{})});
    const productionClaude=this.input.agent==="claude"&&this.#resumeAction!=="attach";
    // Older proof-only fixtures use the unscoped lifecycle. Every production Claude
    // route is app-name scoped so Docker owns the selected identity's credential store.
    const lifecycleRun=(argv:readonly string[],stdin?:Uint8Array)=>productionClaude?run(argv,stdin):this.input.run({executable:this.input.executable,argv,cwd:this.input.cwd,environment:this.input.plan.environment,...(request.signal?{signal:request.signal}:{})});
    const cleanupLifecycleRun=(argv:readonly string[])=>this.input.run({executable:this.input.executable,argv:productionClaude?scoped(argv):argv,cwd:this.input.cwd,environment:this.input.plan.environment});
    let cleanupRequired=false,primaryError:unknown;
    try {
      if(this.#resumeAction!=="attach"){
        const globalPolicy=await lifecycleRun(["policy","ls","--json"]);if(globalPolicy.exitCode!==0)throw new ExecutionError("SBX_GLOBAL_POLICY_UNINITIALIZED","Standalone sbx global policy must be initialized before launch.");
        const create=await lifecycleRun(commands.create);if(create.exitCode!==0)throw new ExecutionError("SBX_CREATE_FAILED","Standalone sbx create failed.");
        // A failed/rejected create did not create a sandbox and must not manufacture a
        // misleading teardown failure. From this point every mismatch is cleanup-bound.
        cleanupRequired=true;
        if(commands.ports.length>2){const ports=await lifecycleRun(commands.ports);if(ports.exitCode!==0)throw new ExecutionError("SBX_PORTS_FAILED","Standalone sbx port publication failed.");}
        for(const argv of commands.policyApply){const applied=await lifecycleRun(argv);if(applied.exitCode!==0)throw new ExecutionError("SBX_POLICY_FAILED","Standalone sbx policy materialization failed.");}
        const checks=[];for(const check of commands.policyChecks){const result=await lifecycleRun(check.argv);checks.push({target:check.target,exitCode:result.exitCode,stdout:result.stdout});}
        try{parsePolicyEvidence({sandboxName:this.input.plan.appName,expected:commands.policyChecks.map(({target,decision})=>({target,decision})),checks});}catch{throw new ExecutionError("SBX_POLICY_FAILED","Standalone sbx policy inspection did not match the selected targets.");}
      }
      if(this.input.worker&&this.#resumeAction!=="attach"){
        const workerCommands=buildSbxCommandPlans(this.input.plan,{agent:this.input.agent,execArgv:this.input.worker.argv,ports:[]});
        const worker=await lifecycleRun(workerCommands.exec);if(worker.exitCode!==0)throw new ExecutionError("SBX_WORKER_FAILED","Standalone sbx remote worker failed to start.");
      }
      if(!productionClaude)return await lifecycleRun(commands.attach);
      const projection=this.#projection!;
      const root=`/opt/mpx/projections/${projection.sha256}`;
      const delivery=await lifecycleRun(["exec",this.input.plan.appName,"mpx-projection-receiver","--sha256",projection.sha256,"--destination",root],projection.archive);
      if(delivery.exitCode!==0)throw new ExecutionError("SBX_PROJECTION_DELIVERY_FAILED","Immutable MPX projection delivery failed.");
      const forwarded=this.#safeClaudeArgv(request.argv);
      return await lifecycleRun(["exec",this.input.plan.appName,"claude","--plugin-dir",path.posix.join(root,projection.pluginPath),"--mcp-config",path.posix.join(root,projection.aggregateMcpPath),...forwarded]);
    } catch(error) {
      primaryError=error;throw error;
    } finally {
      if(cleanupRequired){
        try{const removed=await cleanupLifecycleRun(commands.delete);if(removed.exitCode!==0)throw new ExecutionError("SBX_TEARDOWN_FAILED","Standalone sbx teardown failed.");}
        catch(cleanupError){
          if(primaryError instanceof ExecutionError)throw new ExecutionError(primaryError.code,primaryError.message,{...primaryError.details,cleanupFailure:cleanupError instanceof ExecutionError?cleanupError.code:"SBX_TEARDOWN_FAILED"});
          if(primaryError instanceof Error){Object.defineProperty(primaryError,"cleanupFailure",{value:cleanupError,enumerable:true});throw primaryError;}
          throw cleanupError;
        }
      }
    }
  }
  #validateClaudeEvidence(report:F2ProofReportV1|F2ProofReportV2):boolean{
    const evidence=this.input.claudeEvidence;
    if(!evidence||!report.builtInClaudeEvidence||f2Sha256(evidence)!==f2Sha256(report.builtInClaudeEvidence))return false;
    if(evidence.source!=="live"&&!(evidence.source==="signed-fixture"&&this.input.allowSignedFixtureEvidence===true))return false;
    const identity=this.input.plan.appNamespace.replace(/^mpx-claude-/u,"");
    return this.input.plan.credentialProofRequirements?.provider==="sbx-built-in"&&evidence.identities.some(item=>item.identity===identity&&item.appNamespace===this.input.plan.appNamespace);
  }
  #validateClaudeRoute():boolean {
    const projection=this.#projection;
    if(!projection)return false;
    const digest=createHash("sha256").update(projection.archive).digest("hex");
    const safeRelative=(value:string)=>value.length>0&&!path.posix.isAbsolute(value)&&!value.split("/").includes("..")&&!/[\\\r\n\0]/u.test(value);
    return projection.sha256===digest&&safeRelative(projection.pluginPath)&&safeRelative(projection.aggregateMcpPath)
      &&attestRemoteToolSet(projection.remoteAttestation,PHASE_F2_REMOTE_TOOL_PATHS,this.input.plan.runtimeToolInventorySha256);
  }
  async #bindClaudeLaunch(request:ProcessRequest):Promise<void>{
    const pluginIndex=request.argv.indexOf("--plugin-dir"),mcpIndex=request.argv.indexOf("--mcp-config");
    if(pluginIndex<0||mcpIndex<0||!request.argv[pluginIndex+1]||!request.argv[mcpIndex+1])throw new ExecutionError("SBX_PROJECTION_REQUIRED","A launch-planned Claude projection and aggregate MCP config are required.");
    const pluginRoot=path.resolve(request.argv[pluginIndex+1]!),mcpFile=path.resolve(request.argv[mcpIndex+1]!);
    const files:Array<{path:string;bodyBase64:string}>=[];
    const walk=async(directory:string,relative=""):Promise<void>=>{for(const name of (await readdir(directory)).sort((a,b)=>a.localeCompare(b))){const absolute=path.join(directory,name),next=relative?`${relative}/${name}`:name,info=await lstat(absolute);if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile()))throw new ExecutionError("SBX_PROJECTION_INVALID","Claude projection contains an unsafe entry.");if(info.isDirectory())await walk(absolute,next);else files.push({path:`plugin/${next}`,bodyBase64:(await readFile(absolute)).toString("base64")});}};
    await walk(pluginRoot);files.push({path:"mcp/aggregate.json",bodyBase64:(await readFile(mcpFile)).toString("base64")});files.sort((a,b)=>a.path.localeCompare(b.path));
    const archive=Buffer.from(JSON.stringify({schemaVersion:1,files}),"utf8"),sha256=createHash("sha256").update(archive).digest("hex"),toolPaths=[...PHASE_F2_REMOTE_TOOL_PATHS].sort();
    this.#projection={archive,sha256,pluginPath:"plugin",aggregateMcpPath:"mcp/aggregate.json",remoteAttestation:{toolPaths,digest:sha256Canonical(toolPaths as unknown as JsonValue),inventorySha256:this.input.plan.runtimeToolInventorySha256}};
  }
  #safeClaudeArgv(argv:readonly string[]):readonly string[]{
    const forwarded:string[]=[];for(let index=0;index<argv.length;index++){const value=argv[index]!;if(value==="--plugin-dir"||value==="--mcp-config"){index++;continue;}if(value==="--strict-mcp-config")continue;forwarded.push(value);}
    if(forwarded.some(value=>!value||value.length>8192||/[\r\n\0]/u.test(value)||/CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|claude-gateway|apps[\\/]cli/iu.test(value)))throw new ExecutionError("SBX_CLAUDE_ARGV_INVALID","Claude sandbox argv contains a host-only or private route.");return Object.freeze(forwarded);
  }
}

/** Executor-facing production name retained for callers; lifecycle behavior lives in the deep adapter above. */
export class StandaloneSbxExecutorAdapter extends StandaloneSbxLifecycleAdapter {}
