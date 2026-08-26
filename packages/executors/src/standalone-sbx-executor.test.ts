import { describe, expect, it } from "vitest";
import { createF2ProofReportV1 } from "@mpx/runtime-contracts";
import { buildSandboxPlanV1 } from "./sandbox-plan.js";
import { StandaloneSbxExecutorAdapter } from "./standalone-sbx-executor.js";

const h=(value:string)=>value.repeat(64).slice(0,64);
function fixture(){
  const plan=buildSandboxPlanV1({runtime:"claude",identity:{name:"work",domain:"work"},workspaceMode:"clone",worktreeRole:"main",workspaceRoot:"C:/repo",stateRoot:"C:/state",nativeRoots:["C:/accounts/claude"],credentialRoots:["C:/credentials"],oppositeDomainRoots:["C:/personal"],dockerSocketPaths:["//./pipe/docker_engine"],gitCommonDir:"C:/repo/.git",runtimeToolInventorySha256:h("a"),network:{name:"deny-all",allow:[]}});
  const executorEvidenceSha256=h("b"),sbxPinSha256=h("c"),attestationSha256=h("d");
  const report=createF2ProofReportV1({planKey:plan.planKey,sbxPinSha256,runtimeToolInventorySha256:plan.runtimeToolInventorySha256,executorEvidenceSha256,attestationSha256,verdict:"pass"});
  return {plan,report,executorEvidenceSha256,sbxPinSha256};
}

describe("production standalone sbx executor",()=>{
  it("runs reviewed create, ports, policy, attach and always awaits teardown",async()=>{
    const value=fixture(),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:["127.0.0.1:3042:3042/tcp4"],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
    expect((await adapter.verify()).status).toBe("verified");
    await adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{CLAUDE_CONFIG_DIR:"C:/accounts/claude"}});
    expect(calls.map(call=>call[0])).toEqual(["create","ports","policy","run","rm"]);
    expect(calls.flat().join(" ")).not.toMatch(/CLAUDE_CONFIG_DIR|accounts\/claude|docker_engine/u);
  });

  it("starts the launch-private worker bridge before attach and exposes its exact attestation",async()=>{
    const value=fixture(),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],worker:{argv:["mpx-f2-worker","--stdio"],endpoint:"sbx://launch/bridge",attestationSha256:h("f")},diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
    await adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}});
    expect(calls.map(call=>call[0])).toEqual(["create","policy","exec","run","rm"]);
    expect(calls[2]).toEqual(["exec",value.plan.appName,"mpx-f2-worker","--stdio"]);
    expect(adapter.bridge).toEqual({endpoint:"sbx://launch/bridge",attestationSha256:h("f")});
  });

  it("stays gated when the live proof does not exactly match the plan",async()=>{
    const value=fixture();
    const mismatch={...value.report,planKey:h("f")};
    const adapter=new StandaloneSbxExecutorAdapter({...value,report:mismatch,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async()=>({exitCode:0,stdout:"",stderr:"",truncated:false})});
    expect((await adapter.verify()).status).toBe("unverified");
    await expect(adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}})).rejects.toMatchObject({code:"EXECUTOR_GATE_UNVERIFIED"});
  });
});
