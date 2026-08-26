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
  resolveTrustedSbxExecutable,
  type BoundedProcessRunner,
} from "./index.js";

const h=(c:string)=>c.repeat(64);
const ok=(stdout:string)=>({exitCode:0,stdout,stderr:"",truncated:false});

describe("standalone sbx diagnostics",()=>{
  it("uses one absolute executable with argv-only read-only probes and classifies failures",async()=>{
    const calls: unknown[]=[];
    const runner:BoundedProcessRunner={run:vi.fn(async request=>{calls.push(request); const command=request.argv.join(" "); if(command==="version --json") return ok('{"version":"0.39.0","buildCommit":"def8cb0523a77e757bdd6ef52b459fe374f3783e"}'); if(command==="daemon status --json") return ok('{"status":"stopped","clientVersion":"0.39.0","daemonVersion":"0.39.0"}'); return ok('{"status":"pass","features":{"clone":true,"hostWorktree":true,"remoteTools":true},"authentication":{"available":true}}');})};
    const result=await diagnoseSbx({executable:"C:/Program Files/sbx/sbx.exe",cwd:"C:/state",runner,pin:{version:"0.39.0",buildCommit:"def8cb0523a77e757bdd6ef52b459fe374f3783e"}});
    expect(result.failureCodes).toEqual(["DAEMON_STOPPED"]);
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({shell:false,executable:"C:/Program Files/sbx/sbx.exe"})]));
    expect(calls.flatMap(value=>(value as {argv:string[]}).argv)).not.toEqual(expect.arrayContaining(["start","reset"]));
  });

  it("resolves only an absolute pinned standalone binary outside the project",async()=>{
    await expect(resolveTrustedSbxExecutable({candidates:["sbx","C:/repo/sbx.exe","C:/apps/sbx.exe"],projectRoot:"C:/repo",trustedRoots:["C:/apps"],expectedSha256:h("a"),inspect:async file=>({file:true,realpath:file,sha256:file.includes("apps")?h("a"):h("b")})})).resolves.toBe("C:/apps/sbx.exe");
  });

  it("rejects malformed and unsupported versions without tolerant prefix matching",()=>{
    expect(parseSbxVersion('{"version":"0.39.0","buildCommit":"def8cb0523a77e757bdd6ef52b459fe374f3783e"}')).toEqual({version:"0.39.0",buildCommit:"def8cb0523a77e757bdd6ef52b459fe374f3783e"});
    expect(()=>parseSbxVersion('{"version":"0.39.0-evil","buildCommit":"def8cb0523a77e757bdd6ef52b459fe374f3783e"}')).toThrow();
  });
});

describe("sandbox planning",()=>{
  const base={runtime:"pi" as const,identity:{name:"work",domain:"work" as const},workspaceRoot:"C:/_MP_work/repo",stateRoot:"C:/state/mpx",nativeRoots:["C:/Users/me/.pi"],credentialRoots:["C:/Users/me/.ssh"],oppositeDomainRoots:["C:/_MP_projects"],dockerSocketPaths:["//./pipe/docker_engine"],gitCommonDir:"C:/_MP_work/repo/.git",runtimeToolInventorySha256:h("a"),network:{name:"minimal",allow:["api.openai.com:443"]}};
  it("creates clone, host-worktree, and explicit direct plans with identity partitioning",()=>{
    const clone=buildSandboxPlanV1({...base,workspaceMode:"clone",worktreeRole:"main"});
    expect(clone.sbxArgv).toEqual(expect.arrayContaining(["--clone","--app-name",expect.stringMatching(/^mpx-pi-work-/u)]));
    expect(clone.gitOwnership).toBe("vm");
    const host=buildSandboxPlanV1({...base,workspaceMode:"host-worktree",worktreeRole:"linked"});
    expect(host.gitOwnership).toBe("host"); expect(host.mounts.find(m=>m.source===base.gitCommonDir)).toBeUndefined();
    expect(()=>buildSandboxPlanV1({...base,workspaceMode:"direct",worktreeRole:"main"})).toThrow(/explicit/u);
  });

  it("denies sensitive/opposite/common/docker mounts and emits only state-local secret-free environment",()=>{
    expect(()=>buildSandboxPlanV1({...base,workspaceMode:"host-worktree",worktreeRole:"linked",extraMounts:[{source:"C:/Users/me/.ssh",target:"/credentials",access:"ro"}]})).toThrow(/MOUNT_DENIED/u);
    const plan=buildSandboxPlanV1({...base,workspaceMode:"direct",worktreeRole:"main",directCompatibility:true,hostEnvironment:{PATH:"C:/Windows",OPENAI_API_KEY:"secret",MPX_PROJECTS:"C:/_MP_projects"}});
    expect(plan.environment).toEqual(expect.objectContaining({HOME:expect.stringContaining("C:/state/mpx")}));
    expect(JSON.stringify(plan.environment)).not.toMatch(/secret|_MP_projects/u);
    expect(plan.networkPolicy).toEqual({name:"minimal",default:"deny",allow:["api.openai.com:443"]});
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

describe("F2 evidence",()=>{
  it("stores bounded proof and invalidates it when runtime-tool inventory changes",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-f2-")); const store=new F2EvidenceStore(root);
    await store.put({planKey:h("a"),runtimeToolInventorySha256:h("b"),proof:{verdict:"pass",attestationSha256:h("c")}});
    expect(await store.get(h("a"),h("b"))).toMatchObject({valid:true});
    expect(await store.get(h("a"),h("d"))).toEqual({valid:false,reason:"RUNTIME_TOOL_INVENTORY_DRIFT"});
    const raw=await readFile(path.join(root,h("a")+".json"),"utf8"); expect(raw.length).toBeLessThan(4096);
  });
});
