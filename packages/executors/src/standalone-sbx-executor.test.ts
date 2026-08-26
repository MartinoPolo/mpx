import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createF2ProofReportV1 } from "@mpx/runtime-contracts";
import { FakeSandboxWorker, PHASE_F2_REMOTE_TOOL_PATHS, attestRemoteToolSet, createSandboxHandle } from "./production-remote.js";
import { buildSandboxPlanV1 } from "./sandbox-plan.js";
import { StandaloneSbxExecutorAdapter } from "./standalone-sbx-executor.js";

const h=(value:string)=>value.repeat(64).slice(0,64);
function fixture(runtime:"claude"|"pi"="claude"){
  const plan=buildSandboxPlanV1({runtime,identity:{name:"work",domain:"work"},workspaceMode:"clone",worktreeRole:"main",workspaceRoot:"C:/repo",stateRoot:"C:/state",nativeRoots:["C:/accounts/claude"],credentialRoots:["C:/credentials"],oppositeDomainRoots:["C:/personal"],dockerSocketPaths:["//./pipe/docker_engine"],gitCommonDir:"C:/repo/.git",runtimeToolInventorySha256:h("a"),network:{name:"deny-all",allow:[]}});
  const executorEvidenceSha256=h("b"),sbxPinSha256=h("c"),attestationSha256=h("d");
  const report=createF2ProofReportV1({planKey:plan.planKey,sbxPinSha256,runtimeToolInventorySha256:plan.runtimeToolInventorySha256,executorEvidenceSha256,attestationSha256,verdict:"pass"});
  return {plan,report,executorEvidenceSha256,sbxPinSha256};
}

describe("production standalone sbx executor",()=>{
  it("runs reviewed create, ports, policy, attach and always awaits teardown",async()=>{
    const value=fixture("pi"),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:["127.0.0.1:3042:3042/tcp4"],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
    expect((await adapter.verify()).status).toBe("verified");
    await adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{CLAUDE_CONFIG_DIR:"C:/accounts/claude"}});
    expect(calls.map(call=>call[0])).toEqual(["create","ports","policy","run","rm"]);
    expect(calls.flat().join(" ")).not.toMatch(/CLAUDE_CONFIG_DIR|accounts\/claude|docker_engine/u);
  });

  it("refuses proof-only attach when starting a new Claude sandbox",async()=>{
    const value=fixture(),run=async()=>({exitCode:0,stdout:"",stderr:"",truncated:false as const});
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run});
    await expect(adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}})).rejects.toMatchObject({code:"SBX_PROJECTION_REQUIRED"});
  });

  it("attaches an exactly admitted resume without recreating, host fallback, or orphaning the sbx child process",async()=>{
    const value=fixture(),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
    adapter.setResumeAction("attach");
    await adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}});
    expect(calls.map(call=>call[0])).toEqual(["run"]);
    expect(calls.flat()).not.toContain("host");
  });

  it("starts the launch-private worker bridge before attach and exposes its exact attestation",async()=>{
    const value=fixture("pi"),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],worker:{argv:["mpx-f2-worker","--stdio"],endpoint:"sbx://launch/bridge",attestationSha256:h("f")},diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
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

  it("launches built-in Claude with an immutable VM projection and Docker-side aggregate services",async()=>{
    const value=fixture(),calls:Array<{argv:readonly string[];environment:Readonly<Record<string,string>>;stdin?:Uint8Array}>=[];
    const fakeSbx=fileURLToPath(new URL("../../../scripts/fake-sbx.mjs",import.meta.url));
    const invokeFake=(request:{argv:readonly string[];stdin?:Uint8Array})=>new Promise<{exitCode:number;stdout:string;stderr:string;truncated:false}>((resolve,reject)=>{
      const child=spawn(process.execPath,[fakeSbx,...request.argv],{stdio:["pipe","pipe","pipe"],shell:false,windowsHide:true});let stdout="",stderr="";
      child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);child.once("error",reject);child.once("exit",code=>resolve({exitCode:code??1,stdout,stderr,truncated:false}));child.stdin.end(request.stdin);
    });
    const archive=Buffer.from("fake immutable MPX plugin projection");
    const projectionSha256=createHash("sha256").update(archive).digest("hex");
    const toolPaths=[...PHASE_F2_REMOTE_TOOL_PATHS].sort();
    const remoteAttestation={toolPaths,digest:h("0"),inventorySha256:value.plan.runtimeToolInventorySha256};
    remoteAttestation.digest=createHash("sha256").update(JSON.stringify(toolPaths)).digest("hex");
    expect(attestRemoteToolSet(remoteAttestation,PHASE_F2_REMOTE_TOOL_PATHS,value.plan.runtimeToolInventorySha256)).toBe(true);
    const worker=new FakeSandboxWorker({mcp:async input=>({route:"docker",input}),dev_server:async input=>({route:"docker",input})});
    const remote=createSandboxHandle({launchKey:h("2"),planKey:value.plan.planKey,runtimeToolInventorySha256:value.plan.runtimeToolInventorySha256,capabilitySha256:h("3"),identity:{name:"work",domain:"work"},executor:"docker"},worker);
    await expect(remote.client.execute("mcp",{serverId:"context7",method:"tools/list"})).resolves.toMatchObject({route:"docker"});
    await expect(remote.client.execute("dev_server",{action:"status"})).resolves.toMatchObject({route:"docker"});
    expect(worker.hostFallbackCalls).toBe(0);
    expect(value.plan.credentialProofRequirements).toEqual({provider:"sbx-built-in",enrollment:true,credentialIsolation:true,oppositeIdentityDenial:true});
    const credentialAttestation={appNamespace:value.plan.appNamespace,identity:"work",enrollmentSha256:h("1"),credentialIsolation:true as const,oppositeIdentityDenied:true as const};
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:["127.0.0.1:3042:3042/tcp4"],diagnostics:async()=>({status:"pass",digest:h("e")}),credentialAttestation,projection:{archive,sha256:projectionSha256,pluginPath:"plugin",aggregateMcpPath:"mcp/aggregate.json",remoteAttestation},run:async request=>{calls.push(request);return invokeFake(request);}});

    await expect(adapter.execute({executable:"C:/apps/claude.exe",argv:["--verbose"],cwd:"C:/repo",environment:{CLAUDE_CONFIG_DIR:"C:/accounts/claude",ANTHROPIC_API_KEY:"host-secret"}})).resolves.toMatchObject({exitCode:0});

    expect(calls.map(call=>call.argv[0])).toEqual(["--app-name","--app-name","--app-name","--app-name","--app-name","--app-name"]);
    expect(calls.map(call=>call.argv.slice(0,3))).toEqual(Array(6).fill(["--app-name",value.plan.appNamespace,expect.any(String)]));
    expect(calls.map(call=>call.argv[2])).toEqual(["create","ports","policy","exec","exec","rm"]);
    expect(calls[3]).toMatchObject({stdin:archive});
    expect(calls[3]!.argv).toEqual(["--app-name",value.plan.appNamespace,"exec",value.plan.appName,"mpx-projection-receiver","--sha256",projectionSha256,"--destination",`/opt/mpx/projections/${projectionSha256}`]);
    expect(calls[4]!.argv).toEqual(["--app-name",value.plan.appNamespace,"exec",value.plan.appName,"claude","--plugin-dir",`/opt/mpx/projections/${projectionSha256}/plugin`,"--mcp-config",`/opt/mpx/projections/${projectionSha256}/mcp/aggregate.json`,"--verbose"]);
    const serialized=JSON.stringify(calls.map(call=>({argv:call.argv,environment:call.environment})));
    expect(serialized).not.toMatch(/CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|host-secret|accounts[\\/]claude|apps[\\/]cli|claude-gateway/iu);

    const mismatch=new StandaloneSbxExecutorAdapter({...adapter.input,credentialAttestation:{...credentialAttestation,oppositeIdentityDenied:false as never},run:async request=>{calls.push(request);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
    await expect(mismatch.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}})).rejects.toMatchObject({code:"EXECUTOR_GATE_UNVERIFIED"});
    expect(calls.at(-1)!.argv.slice(2)).toEqual(["rm","--force",value.plan.appName]);
  });
});
