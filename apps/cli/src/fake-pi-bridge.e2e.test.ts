import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FakeSandboxWorker, createSandboxHandle, startLaunchPrivateBridge, type LaunchPrivateBridge } from "@mpx/executors";
import { createRuntimeContextV1 } from "@mpx/runtime-contracts";
import { planPiInvocation } from "@mpx/runtime-pi";
const h=(c:string)=>c.repeat(64);const roots:string[]=[];const bridges:LaunchPrivateBridge[]=[];
afterEach(async()=>{await Promise.all(bridges.splice(0).map(bridge=>bridge.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

it("runs a fake Pi executable through the actual invocation plan and launch-private sbx worker bridge",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"mpx-fake-pi-"));roots.push(root);await mkdir(path.join(root,"state"));
 const binding={launchKey:h("a"),planKey:h("b"),runtimeToolInventorySha256:h("c"),capabilitySha256:h("d"),identity:{name:"personal",domain:"personal" as const},executor:"docker" as const};
 const worker=new FakeSandboxWorker({read:async input=>({worker:"sbx",input})}),handle=createSandboxHandle(binding,worker),bridge=await startLaunchPrivateBridge({stateRoot:path.join(root,"state"),binding:handle.descriptor,client:handle.client});bridges.push(bridge);
 const fake=path.join(root,"fake-pi.mjs"),extension=path.join(root,"extension.mjs"),contextFile=path.join(root,"context.json");await Promise.all([writeFile(extension,"export default function(){}"),writeFile(contextFile,"{}"),writeFile(fake,`import{createConnection}from'node:net';const c=JSON.parse(process.env.MPX_PI_LAUNCH_PRIVATE_BRIDGE);const p=Number(c.endpoint.split(':').at(-1));const q={schemaVersion:1,kind:'request',requestId:'fake-pi-call',nonce:c.nonce,launchKey:c.launchKey,identity:c.identity,planKey:c.planKey,runtimeToolInventorySha256:c.runtimeToolInventorySha256,capabilitySha256:c.capabilitySha256,toolPath:'read',input:{file:'inside-vm'}};const s=createConnection({host:'127.0.0.1',port:p},()=>s.write(JSON.stringify(q)+'\\n'));let b='';s.on('data',x=>b+=x);s.on('end',()=>process.stdout.write(b));`)]);
 const context=createRuntimeContextV1({launchKey:binding.launchKey,launchDescriptor:{reference:"launch.json",digest:h("e")},manifestKey:h("f"),runtimeArtifact:{schemaVersion:4,runtime:"pi",manifestKey:h("f"),artifactKey:h("1"),fileMapHash:h("2")},binding:{projectId:"app",repositoryId:"repo",contentScope:"personal"}});
 const plan=planPiInvocation({executable:process.execPath,extension,theme:"dark",accountRoot:root,runtimeContextFile:contextFile,runtimeContext:context,cwd:root,bridge:bridge.config});
 const result=await new Promise<{code:number|null;stdout:string}>((resolve,reject)=>{const child=spawn(plan.executable,[fake,...plan.args],{cwd:plan.cwd,env:{...process.env,...plan.env},shell:false});let stdout="";child.stdout.on("data",chunk=>stdout+=chunk);child.once("error",reject);child.once("exit",code=>resolve({code,stdout}));});
 expect(result.code).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({kind:"result",output:{worker:"sbx",input:{file:"inside-vm"}}});expect(worker.hostFallbackCalls).toBe(0);
});
