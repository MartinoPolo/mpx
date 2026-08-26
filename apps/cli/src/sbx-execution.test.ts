import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { createF2ProofReportV1 } from "@mpx/runtime-contracts";
import { SBX_V0_39_0_PIN } from "@mpx/executors";
import { createProductionSbxExecutionAdapter, loadProductionSbxProofSources, planProductionSbxExecution } from "./sbx-execution.js";

const h=(value:string)=>value.repeat(64).slice(0,64);
const sha=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");

it("loads all F2 evidence from a copied immutable release after the source checkout is unavailable",async()=>{
  const release=await mkdtemp(path.join(tmpdir(),"mpx-installed-release-")),bin=path.join(release,"bin"),evidence=path.join(release,"evidence");
  await Promise.all([mkdir(bin),mkdir(evidence)]);
  const executor=Buffer.from("installed executor evidence"),inventory={runtimeToolInventorySha256:h("1"),executorEvidenceBindingSha256:sha(executor)};
  await Promise.all([
    writeFile(path.join(bin,"mpx.mjs"),"// copied release bundle"),
    writeFile(path.join(evidence,"executor-evidence.ts"),executor),
    writeFile(path.join(evidence,"runtime-tool-inventory.json"),JSON.stringify(inventory)),
    writeFile(path.join(evidence,"sbx-pin.json"),"installed sbx pin"),
  ]);
  await expect(loadProductionSbxProofSources({},pathToFileURL(path.join(bin,"mpx.mjs")).href)).resolves.toEqual({sbxPinSha256:sha("installed sbx pin"),runtimeToolInventorySha256:h("1"),executorEvidenceSha256:sha(executor)});
});

it("selects verified standalone sbx evidence and runs create, policy, worker bridge, attach, and awaited teardown",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"mpx-sbx-cli-")),cwd=path.join(root,"repo"),stateRoot=path.join(root,"state"),executable=path.join(root,"apps","sbx.exe");
  await Promise.all([mkdir(cwd),mkdir(stateRoot),mkdir(path.dirname(executable))]);await writeFile(executable,"fake");
  const sources={sbxPinSha256:h("b"),runtimeToolInventorySha256:h("1"),executorEvidenceSha256:h("e")};
  const input={environment:{MPX_SBX_EXECUTABLE:executable},cwd,stateRoot,runtime:"pi" as const,identity:{name:"work",domain:"work" as const},workspaceMode:"clone" as const,worktreeRole:"main" as const,workspaceRoot:cwd,gitCommonDir:path.join(cwd,".git"),nativeRoots:[path.join(root,"native")],credentialRoots:[path.join(root,"credentials")],oppositeDomainRoots:[path.join(root,"personal")],network:{name:"implementation",allow:["api.openai.com:443"]},ports:[4310],sources};
  const planned=planProductionSbxExecution(input),proof=createF2ProofReportV1({planKey:planned.plan.planKey,...sources,attestationSha256:h("a"),verdict:"pass"});
  const calls:string[][]=[];
  const adapter=await createProductionSbxExecutionAdapter({...input,proof},{inspectExecutable:async file=>({file:true,realpath:file,sha256:SBX_V0_39_0_PIN.windowsBinarySha256}),diagnostics:async()=>({status:"pass",digest:h("d")}),run:async request=>{calls.push([...request.argv]);return {exitCode:0,stdout:"",stderr:"",truncated:false};}});
  expect(await adapter.verify()).toEqual({status:"verified",verifier:"standalone-sbx-live",evidenceDigest:proof.reportKey});
  await adapter.execute({executable:process.execPath,argv:[],cwd,environment:{}});
  expect(calls.map(call=>call[0])).toEqual(["create","ports","policy","exec","run","rm"]);
  expect(adapter.bridge).toEqual({endpoint:`sbx://${planned.plan.appName}/worker`,attestationSha256:expect.stringMatching(/^[a-f0-9]{64}$/u)});
});

it("denies stale proof without invoking sbx or falling back to host",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"mpx-sbx-stale-")),cwd=path.join(root,"repo"),stateRoot=path.join(root,"state"),executable=path.join(root,"sbx.exe");await Promise.all([mkdir(cwd),mkdir(stateRoot),writeFile(executable,"fake")]);
  const run=vi.fn(async()=>({exitCode:0,stdout:"",stderr:"",truncated:false}));
  const adapter=await createProductionSbxExecutionAdapter({environment:{MPX_SBX_EXECUTABLE:executable},cwd,stateRoot,runtime:"claude",identity:{name:"work",domain:"work"},workspaceMode:"clone",worktreeRole:"main",workspaceRoot:cwd,gitCommonDir:path.join(cwd,".git"),nativeRoots:[],credentialRoots:[],oppositeDomainRoots:[],network:{name:"deny-all",allow:[]},ports:[],sources:{sbxPinSha256:h("b"),runtimeToolInventorySha256:h("1"),executorEvidenceSha256:h("e")},proof:createF2ProofReportV1({planKey:h("f"),sbxPinSha256:h("b"),runtimeToolInventorySha256:h("1"),executorEvidenceSha256:h("e"),attestationSha256:h("a"),verdict:"pass"})},{inspectExecutable:async file=>({file:true,realpath:file,sha256:SBX_V0_39_0_PIN.windowsBinarySha256}),diagnostics:async()=>({status:"pass",digest:h("d")}),run});
  expect((await adapter.verify()).status).toBe("unverified");
  await expect(adapter.execute({executable:process.execPath,argv:[],cwd,environment:{}})).rejects.toMatchObject({code:"EXECUTOR_GATE_UNVERIFIED"});expect(run).not.toHaveBeenCalled();
});
