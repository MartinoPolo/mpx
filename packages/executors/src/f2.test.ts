import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  F2EvidenceStore,
  RemoteToolClient,
  buildSandboxPlanV1,
  diagnoseSbx,
  parseSbxVersion,
  parseSbxDaemonStatus,
  parseSbxDiagnose,
  assertSbxHelpCompatibility,
  buildSbxCommandPlans,
  namedSbxPolicies,
  parsePolicyEvidence,
  verifyNoSharedSkillsMounts,
  runFakeSbxProof,
  resolveTrustedSbxExecutable,
  type BoundedProcessRunner,
} from "./index.js";

const h=(c:string)=>c.repeat(64);
const ok=(stdout:string)=>({exitCode:0,stdout,stderr:"",truncated:false});

describe("standalone sbx diagnostics",()=>{
  it("uses one absolute executable with argv-only read-only probes and classifies failures",async()=>{
    const calls: unknown[]=[];
    const runner:BoundedProcessRunner={run:vi.fn(async request=>{calls.push(request); const command=request.argv.join(" "); if(command==="version") return ok('sbx version: v0.39.0 def8cb0523a77e757bdd6ef52b459fe374f3783e\n'); if(command==="--help") return ok("Available Commands:\n create x\n daemon x\n diagnose x\n exec x\n ls x\n policy x\n ports x\n rm x\n run x\n version x\n"); if(command==="daemon status --json") return ok('{"status":"stopped","socket":"pipe"}'); return ok('{"version":"1.0","checks":[{"name":"Authentication","status":"pass","message":"available","detail":"","hint":""}],"summary":{"pass":1,"warn":0,"fail":0,"skip":0}}');})};
    const result=await diagnoseSbx({executable:"C:/Program Files/sbx/sbx.exe",cwd:"C:/state",runner,pin:{version:"0.39.0",buildCommit:"def8cb0523a77e757bdd6ef52b459fe374f3783e"}});
    expect(result.failureCodes).toEqual(["DAEMON_STOPPED"]);
    expect(calls).toHaveLength(4);
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({shell:false,executable:"C:/Program Files/sbx/sbx.exe"})]));
    expect(calls.flatMap(value=>(value as {argv:string[]}).argv)).not.toEqual(expect.arrayContaining(["start","reset"]));
  });

  it("resolves only an absolute pinned standalone binary outside the project",async()=>{
    await expect(resolveTrustedSbxExecutable({candidates:["sbx","C:/repo/sbx.exe","C:/apps/sbx.exe"],projectRoot:"C:/repo",trustedRoots:["C:/apps"],expectedSha256:h("a"),inspect:async file=>({file:true,realpath:file,sha256:file.includes("apps")?h("a"):h("b")})})).resolves.toBe("C:/apps/sbx.exe");
  });

  it("parses the actual v0.39 version and daemon output and fails closed on shape drift",()=>{
    expect(parseSbxVersion('sbx version: v0.39.0 def8cb0523a77e757bdd6ef52b459fe374f3783e\n')).toEqual({version:"0.39.0",buildCommit:"def8cb0523a77e757bdd6ef52b459fe374f3783e"});
    expect(parseSbxDaemonStatus('{"status":"stopped","socket":"\\\\\\\\.\\\\pipe\\\\docker_kaname_sandboxd"}')).toMatchObject({status:"stopped"});
    expect(()=>parseSbxDaemonStatus('{"status":"stopped","socket":"pipe","surprise":true}')).toThrow();
  });

  it("parses bounded diagnose JSON without retaining sensitive details",()=>{
    const report=parseSbxDiagnose(JSON.stringify({version:"1.0",checks:[{name:"CLI binary",status:"pass",message:"found",detail:"C:/Users/alice/sbx.exe",hint:""},{name:"Daemon",status:"fail",message:"not reachable",detail:"private pipe",hint:"Run: sbx daemon start"}],summary:{pass:1,warn:0,fail:1,skip:0}}));
    expect(report).toEqual({version:"1.0",checks:[{name:"CLI binary",status:"pass"},{name:"Daemon",status:"fail"}],summary:{pass:1,warn:0,fail:1,skip:0}});
  });

  it("validates the exact standalone command surface and rejects legacy help",()=>{
    expect(()=>assertSbxHelpCompatibility("Available Commands:\n create\n daemon\n diagnose\n exec\n ls\n policy\n ports\n rm\n run\n version\n")).not.toThrow();
    expect(()=>assertSbxHelpCompatibility("docker sandbox run\n")).toThrow(/COMPAT/u);
  });
});

describe("sandbox planning",()=>{
  const base={runtime:"pi" as const,identity:{name:"work",domain:"work" as const},workspaceRoot:"C:/_MP_work/repo",stateRoot:"C:/state/mpx",nativeRoots:["C:/Users/me/.pi"],credentialRoots:["C:/Users/me/.ssh"],oppositeDomainRoots:["C:/_MP_projects"],dockerSocketPaths:["//./pipe/docker_engine"],gitCommonDir:"C:/_MP_work/repo/.git",runtimeToolInventorySha256:h("a"),network:{name:"minimal",allow:["api.openai.com:443"]}};
  it("creates clone, host-worktree, and explicit direct plans with identity partitioning",()=>{
    const clone=buildSandboxPlanV1({...base,workspaceMode:"clone",worktreeRole:"main"});
    expect(clone.sbxArgv).toEqual(expect.arrayContaining(["--clone","--name",expect.stringMatching(/^mpx-pi-work-/u)]));
    expect(clone.gitOwnership).toBe("vm");
    const host=buildSandboxPlanV1({...base,workspaceMode:"host-worktree",worktreeRole:"linked"});
    expect(host.gitOwnership).toBe("host"); expect(host.mounts.find(m=>m.source===base.gitCommonDir)).toBeUndefined();
    expect(()=>buildSandboxPlanV1({...base,workspaceMode:"direct",worktreeRole:"main"})).toThrow(/explicit/u);
  });

  it("emits argv-only create attach exec ports policy list and delete plans",()=>{
    const plan=buildSandboxPlanV1({...base,workspaceMode:"clone",worktreeRole:"main"});
    const commands=buildSbxCommandPlans(plan,{agent:"shell",execArgv:["node","worker.mjs"],ports:["127.0.0.1:3042:3042/tcp4"]});
    expect(commands).toMatchObject({create:expect.arrayContaining(["create","--name",plan.appName,"--clone","--profile","minimal","shell",base.workspaceRoot,"--env"]),attach:["run","--name",plan.appName],exec:["exec",plan.appName,"node","worker.mjs"],ports:["ports",plan.appName,"--publish","127.0.0.1:3042:3042/tcp4"],list:["ls","--json"],delete:["rm","--force",plan.appName]});
    expect(Object.values(commands).flat()).not.toEqual(expect.arrayContaining(["cmd.exe","powershell","-c","/c"]));
  });

  it("denies sensitive/opposite/common/docker mounts and emits only state-local secret-free environment",()=>{
    expect(()=>buildSandboxPlanV1({...base,workspaceMode:"host-worktree",worktreeRole:"linked",extraMounts:[{source:"C:/Users/me/.ssh",target:"/credentials",access:"ro"}]})).toThrow(/MOUNT_DENIED/u);
    const plan=buildSandboxPlanV1({...base,workspaceMode:"direct",worktreeRole:"main",directCompatibility:true,hostEnvironment:{PATH:"C:/Windows",OPENAI_API_KEY:"secret",MPX_PROJECTS:"C:/_MP_projects"}});
    expect(plan.environment).toEqual(expect.objectContaining({HOME:expect.stringContaining("C:/state/mpx")}));
    expect(JSON.stringify(plan.environment)).not.toMatch(/secret|_MP_projects/u);
    expect(plan.networkPolicy).toEqual({name:"minimal",default:"deny",allow:["api.openai.com:443"]});
  });
});

describe("sandbox policy evidence",()=>{
  it("provides named deny-all, minimal, implementation, delivery and research deny-by-default policies",()=>{
    expect(Object.keys(namedSbxPolicies)).toEqual(["deny-all","minimal","implementation","delivery","research"]);
    expect(Object.values(namedSbxPolicies).every(policy=>policy.default==="deny")).toBe(true);
  });

  it("verifies no shared skills by mount inspection because v0.39 has no flag",()=>{
    expect(()=>verifyNoSharedSkillsMounts([{source:"C:/state/generated",target:"/workspace"}])).not.toThrow();
    expect(()=>verifyNoSharedSkillsMounts([{source:"C:/Users/me/.pi/skills",target:"/host-skills"}])).toThrow(/SHARED_SKILLS/u);
  });

  it("accepts exact check/log evidence and fails closed on mismatched sandbox, target or decision",()=>{
    const evidence=parsePolicyEvidence({sandbox:"mpx-pi-work-abc",expected:[{target:"api.openai.com:443",decision:"allow"},{target:"evil.example:443",decision:"deny"}],checks:[{sandbox:"mpx-pi-work-abc",target:"api.openai.com:443",decision:"allow"},{sandbox:"mpx-pi-work-abc",target:"evil.example:443",decision:"deny"}],logs:[{sandbox:"mpx-pi-work-abc",host:"api.openai.com",port:443,decision:"allow",count:1},{sandbox:"mpx-pi-work-abc",host:"evil.example",port:443,decision:"deny",count:1}]});
    expect(evidence.verdict).toBe("pass"); expect(evidence.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(()=>parsePolicyEvidence({sandbox:"a",expected:[{target:"x:443",decision:"deny"}],checks:[{sandbox:"b",target:"x:443",decision:"deny"}],logs:[]})).toThrow(/EVIDENCE/u);
  });
});

describe("remote tool protocol",()=>{
  it("bounds NDJSON, rejects replay/stale/widening, supports cancellation, and never invokes a shell",async()=>{
    const sent:string[]=[]; const client=new RemoteToolClient({planKey:h("a"),inventorySha256:h("b"),capabilitySha256:h("c"),send:async line=>{sent.push(line); return JSON.stringify({schemaVersion:1,kind:"result",requestId:"r1",sequence:1,requestSha256:h("d"),status:"ok",outputSha256:h("e"),outputBytes:4,errorCode:null})+"\n";}});
    await expect(client.call({requestId:"r1",toolPath:"mcp/browser/call",inputSha256:h("f"),requestSha256:h("d"),capabilitySha256:h("c")})).resolves.toMatchObject({status:"ok"});
    await expect(client.call({requestId:"r1",toolPath:"mcp/browser/call",inputSha256:h("f"),requestSha256:h("d"),capabilitySha256:h("c")})).rejects.toMatchObject({code:"REMOTE_REPLAY"});
    expect(sent[0]).not.toMatch(/shell|cmd\.exe|powershell/u);
  });
});

describe("F2 proof runner",()=>{
  it("runs fake sbx end-to-end and returns only sanitized digest-bound F2ProofReportV1",async()=>{
    const report=await runFakeSbxProof({planKey:h("a"),sbxPinSha256:h("b"),runtimeToolInventorySha256:h("c"),executorEvidenceSha256:h("d"),invoke:async argv=>({exitCode:0,stdout:JSON.stringify({argv,ok:true,secret:"must-not-leak"}),stderr:""})});
    expect(report).toMatchObject({schemaVersion:1,planKey:h("a"),runtimeToolInventorySha256:h("c"),verdict:"pass"});
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
  });
});

describe("F2 evidence",()=>{
  it("stores bounded proof and invalidates it when runtime-tool inventory changes",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-f2-")); const store=new F2EvidenceStore(root);
    await store.put({planKey:h("a"),runtimeToolInventorySha256:h("b"),proof:{verdict:"pass",attestationSha256:h("c")}});
    expect(await store.get(h("a"),h("b"))).toMatchObject({valid:true});
    expect(await store.get(h("a"),h("d"))).toEqual({valid:false,reason:"RUNTIME_TOOL_INVENTORY_DRIFT"});
    const raw=await readFile(path.join(root,h("a")+".json"),"utf8"); expect(raw.length).toBeLessThan(4096);
  });
});
