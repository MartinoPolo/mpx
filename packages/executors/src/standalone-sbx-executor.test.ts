import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createF2ProofReportV1, type BuiltInClaudeEvidenceV1 } from "@mpx/runtime-contracts";
import { FakeSandboxWorker, PHASE_F2_REMOTE_TOOL_PATHS, attestRemoteToolSet, createSandboxHandle } from "./production-remote.js";
import { buildSandboxPlanV1 } from "./sandbox-plan.js";
import { StandaloneSbxExecutorAdapter } from "./standalone-sbx-executor.js";

const h=(value:string)=>value.repeat(64).slice(0,64);
const success=(argv:readonly string[])=>{const target=argv[argv.indexOf("--sandbox")+2];if(argv.includes("check")&&target){const allowed=target!=="blocked.invalid:443";return{exitCode:allowed?0:1,stdout:JSON.stringify({action:"net:connect:tcp",allowed,resource_value:target,type:"network",...(!allowed?{deny_kind:"implicit",reason:"default deny",rule:"default"}:{})}),stderr:"",truncated:false as const};}return{exitCode:0,stdout:"",stderr:"",truncated:false as const};};
const signedClaudeEvidence:BuiltInClaudeEvidenceV1={source:"signed-fixture",identities:[
  {identity:"personal",appNamespace:"mpx-claude-personal",enrollmentEvidenceSha256:h("1"),isolationEvidenceSha256:h("2"),oppositeIdentityDenialEvidenceSha256:h("3"),captureSignatureSha256:h("4")},
  {identity:"work",appNamespace:"mpx-claude-work",enrollmentEvidenceSha256:h("5"),isolationEvidenceSha256:h("6"),oppositeIdentityDenialEvidenceSha256:h("7"),captureSignatureSha256:h("8")},
]};
function fixture(runtime:"claude"|"pi"="claude",builtInClaudeEvidence:BuiltInClaudeEvidenceV1|null=null,network:{name:string;allow:readonly string[]}={name:"deny-all",allow:[]}){
  const plan=buildSandboxPlanV1({runtime,identity:{name:"work",domain:"work"},workspaceMode:"clone",worktreeRole:"main",workspaceRoot:"C:/repo",stateRoot:"C:/state",nativeRoots:["C:/accounts/claude"],credentialRoots:["C:/credentials"],oppositeDomainRoots:["C:/personal"],dockerSocketPaths:["//./pipe/docker_engine"],gitCommonDir:"C:/repo/.git",runtimeToolInventorySha256:h("a"),network});
  const executorEvidenceSha256=h("b"),sbxPinSha256=h("c"),attestationSha256=h("d");
  const report=createF2ProofReportV1({planKey:plan.planKey,sbxPinSha256,runtimeToolInventorySha256:plan.runtimeToolInventorySha256,executorEvidenceSha256,attestationSha256,builtInClaudeEvidence,verdict:"pass"});
  return {plan,report,executorEvidenceSha256,sbxPinSha256};
}

describe("production standalone sbx executor",()=>{
  it("runs reviewed create, ports, policy, attach and always awaits teardown",async()=>{
    const value=fixture("pi"),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:["127.0.0.1:3042:3042/tcp4"],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return success(request.argv);}});
    expect((await adapter.verify()).status).toBe("verified");
    await adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{CLAUDE_CONFIG_DIR:"C:/accounts/claude"}});
    expect(calls.map(call=>call[0])).toEqual(["policy","create","ports","policy","run","rm"]);
    expect(calls.flat().join(" ")).not.toMatch(/CLAUDE_CONFIG_DIR|accounts\/claude|docker_engine/u);
  });

  it("preflights initialized global open policy and performs only a bounded allow probe",async()=>{
    const value=fixture("pi",null,{name:"open",allow:[]}),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return success(request.argv);}});
    await adapter.execute({executable:"tool",argv:[],cwd:"C:/repo",environment:{}});
    expect(calls).toEqual([
      ["policy","ls","--json"],
      expect.arrayContaining(["create","--name",value.plan.appName]),
      ["policy","check","network","--sandbox",value.plan.appName,"example.com:443","--json"],
      ["run","--name",value.plan.appName],
      ["rm","--force",value.plan.appName],
    ]);
  });

  it("materializes and verifies the exact logical policy targets without an sbx profile or explicit deny",async()=>{
    const targets=["api.anthropic.com:443","api.openai.com:443"],value=fixture("pi",null,{name:"minimal",allow:targets}),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return success(request.argv);}});
    await adapter.execute({executable:"tool",argv:[],cwd:"C:/repo",environment:{}});
    expect(calls[1]).not.toContain("--profile");
    expect(calls[2]).toEqual(["policy","allow","network","--sandbox",value.plan.appName,...targets]);
    expect(calls.filter(argv=>argv[0]==="policy"&&argv[1]==="check")).toHaveLength(3);
    expect(calls.some(argv=>argv[1]==="deny"||argv.includes("add")||argv.includes("set"))).toBe(false);
  });

  it("denies an offline Claude proof before create when independently captured identity evidence is absent",async()=>{
    const value=fixture(),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return success(request.argv);}});
    await expect(adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}})).rejects.toMatchObject({code:"EXECUTOR_GATE_UNVERIFIED"});
    expect(calls).toEqual([]);
  });

  it("attaches an exactly admitted resume without recreating, host fallback, or orphaning the sbx child process",async()=>{
    const value=fixture(),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return success(request.argv);}});
    adapter.setResumeAction("attach");
    await adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}});
    expect(calls.map(call=>call[0])).toEqual(["run"]);
    expect(calls.flat()).not.toContain("host");
  });

  it("starts the launch-private worker bridge before attach and exposes its exact attestation",async()=>{
    const value=fixture("pi"),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],worker:{argv:["mpx-f2-worker","--stdio"],endpoint:"sbx://launch/bridge",attestationSha256:h("f")},diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);return success(request.argv);}});
    await adapter.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}});
    expect(calls.map(call=>call[0])).toEqual(["policy","create","policy","exec","run","rm"]);
    expect(calls[3]).toEqual(["exec",value.plan.appName,"mpx-f2-worker","--stdio"]);
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
    const value=fixture("claude",signedClaudeEvidence),calls:Array<{argv:readonly string[];environment:Readonly<Record<string,string>>;stdin?:Uint8Array}>=[];
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
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"claude",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:["127.0.0.1:3042:3042/tcp4"],diagnostics:async()=>({status:"pass",digest:h("e")}),claudeEvidence:signedClaudeEvidence,allowSignedFixtureEvidence:true,projection:{archive,sha256:projectionSha256,pluginPath:"plugin",aggregateMcpPath:"mcp/aggregate.json",remoteAttestation},run:async request=>{calls.push(request);return invokeFake(request);}});

    await expect(adapter.execute({executable:"C:/apps/claude.exe",argv:["--verbose"],cwd:"C:/repo",environment:{CLAUDE_CONFIG_DIR:"C:/accounts/claude",ANTHROPIC_API_KEY:"host-secret"}})).resolves.toMatchObject({exitCode:0});

    expect(calls.map(call=>call.argv[0])).toEqual(["--app-name","--app-name","--app-name","--app-name","--app-name","--app-name","--app-name"]);
    expect(calls.map(call=>call.argv.slice(0,3))).toEqual(Array(7).fill(["--app-name",value.plan.appNamespace,expect.any(String)]));
    expect(calls.map(call=>call.argv[2])).toEqual(["policy","create","ports","policy","exec","exec","rm"]);
    expect(calls[4]).toMatchObject({stdin:archive});
    expect(calls[4]!.argv).toEqual(["--app-name",value.plan.appNamespace,"exec",value.plan.appName,"mpx-projection-receiver","--sha256",projectionSha256,"--destination",`/opt/mpx/projections/${projectionSha256}`]);
    expect(calls[5]!.argv).toEqual(["--app-name",value.plan.appNamespace,"exec",value.plan.appName,"claude","--plugin-dir",`/opt/mpx/projections/${projectionSha256}/plugin`,"--mcp-config",`/opt/mpx/projections/${projectionSha256}/mcp/aggregate.json`,"--verbose"]);
    const serialized=JSON.stringify(calls.map(call=>({argv:call.argv,environment:call.environment})));
    expect(serialized).not.toMatch(/CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|host-secret|accounts[\\/]claude|apps[\\/]cli|claude-gateway/iu);

    const mismatch=new StandaloneSbxExecutorAdapter({...adapter.input,claudeEvidence:{...signedClaudeEvidence,identities:[signedClaudeEvidence.identities[0],{...signedClaudeEvidence.identities[1],captureSignatureSha256:h("9")}]},run:async request=>{calls.push(request);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
    await expect(mismatch.execute({executable:"C:/apps/claude.exe",argv:[],cwd:"C:/repo",environment:{}})).rejects.toMatchObject({code:"EXECUTOR_GATE_UNVERIFIED"});
    expect(calls.at(-1)!.argv.slice(2)).toEqual(["rm","--force",value.plan.appName]);
  });

  it("does not attempt teardown when create rejects before a sandbox exists",async()=>{
    const value=fixture("pi"),calls:string[][]=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{calls.push([...request.argv]);if(request.argv[0]==="create")throw new Error("create transport rejected");return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
    await expect(adapter.execute({executable:"tool",argv:[],cwd:"C:/repo",environment:{}})).rejects.toThrow("create transport rejected");
    expect(calls.map(call=>call[0])).toEqual(["policy","create"]);
  });

  it("runs cancellation cleanup outside the aborted launch signal",async()=>{
    const value=fixture("pi"),abort=new AbortController(),cleanupSignals:Array<AbortSignal|undefined>=[];
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>{if(request.argv[0]==="create"){abort.abort();throw new Error("cancelled");}cleanupSignals.push(request.signal);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
    await expect(adapter.execute({executable:"tool",argv:[],cwd:"C:/repo",environment:{},signal:abort.signal})).rejects.toThrow("cancelled");
    expect(cleanupSignals).toEqual([abort.signal]);
  });

  it("does not report a false teardown failure when create exits nonzero",async()=>{
    const value=fixture("pi");
    const adapter=new StandaloneSbxExecutorAdapter({...value,agent:"shell",executable:"C:/apps/sbx.exe",cwd:"C:/repo",ports:[],diagnostics:async()=>({status:"pass",digest:h("e")}),run:async request=>request.argv[0]==="rm"?{exitCode:8,stdout:"",stderr:"",truncated:false}:request.argv[0]==="create"?{exitCode:7,stdout:"",stderr:"",truncated:false}:{exitCode:0,stdout:"",stderr:"",truncated:false}});
    await expect(adapter.execute({executable:"tool",argv:[],cwd:"C:/repo",environment:{}})).rejects.toMatchObject({code:"SBX_CREATE_FAILED",details:undefined});
  });
});
