import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DevServiceManager, DurableDevServiceManager, RollingLogBuffer, assertExecutorBoundary, createDevServerToolAdapter, createSystemRuntime, replaceAtomicFile, systemSpawnInvocation, validateStartRequest, type ManagedProcess, type RuntimeAdapter } from "./index.js";

class Child extends EventEmitter implements ManagedProcess {
  stdout=new PassThrough(); stderr=new PassThrough(); fingerprint="started:100"; closed:Promise<{code:number|null;signal:string|null}>; resolve!: (v:{code:number|null;signal:string|null})=>void;
  constructor(readonly pid:number){ super(); this.closed=new Promise(r=>this.resolve=r); }
  exit(code:number|null=0,signal:string|null=null){const e={code,signal};this.emit("close",e);this.resolve(e)}
  onClose(fn:(e:{code:number|null;signal:string|null})=>void){this.on("close",fn)}
}
class Runtime implements RuntimeAdapter {
  kind="host" as const; children:Child[]=[]; probes=new Map<number,boolean[]>(); stopped:number[]=[]; inspections=0; tick=0;
  now=()=>new Date(1700000000000+this.tick++).toISOString(); sleep=async()=>{};
  spawn=()=>{const c=new Child(100+this.children.length);this.children.push(c);return c};
  probe=async(port:number)=>this.probes.get(port)?.shift()??false;
  inspect=async(pid:number)=>{this.inspections++;return {pid,fingerprint:this.children.find(c=>c.pid===pid)?.fingerprint??"other"}};
  stop=async(c:ManagedProcess)=>{this.stopped.push(c.pid);(c as Child).exit(null,"SIGTERM")};
}
const request={id:"web",executable:"npm",args:["run","dev"],cwd:"C:/repo",ports:[4100,4101],assignment:{worktreeRoot:"C:/repo",ports:[4100,4101]},executor:"host" as const};

describe("managed development services",()=>{
  it("spawns an executable and argv directly without shell interpolation",()=>{
    expect(systemSpawnInvocation("npm",["run","dev; touch owned"],"linux")).toEqual({file:"npm",args:["run","dev; touch owned"],detached:true});
    expect(systemSpawnInvocation("npm",["run","dev & calc"],"win32")).toEqual({file:"npm",args:["run","dev & calc"],detached:false});
  });
  it("validates and preserves the complete assigned environment map",()=>{
    const validated=validateStartRequest({...request,environment:{WEB_URL:"http://localhost:4100",API_URL:"http://localhost:4101"}});
    expect(validated.environment).toEqual({WEB_URL:"http://localhost:4100",API_URL:"http://localhost:4101"});
    expect(()=>validateStartRequest({...request,environment:{"BAD-KEY":"x"}})).toThrow(/environment/);
  });
  it("fails closed rather than executing host runtime for a Docker launch",()=>expect(()=>assertExecutorBoundary("docker","host")).toThrow(/Docker executor/));
  it("rejects ports not assigned to the exact worktree",()=>expect(()=>validateStartRequest({...request,ports:[4100,9999]})).toThrow(/assigned/));
  it("rejects malicious ids and cwd escapes",()=>{
    expect(()=>validateStartRequest({...request,id:"../victim"})).toThrow(/id/);
    expect(()=>validateStartRequest({...request,cwd:"C:/repo-evil"})).toThrow(/worktree/);
  });
  it("waits until every configured port is ready and emits status events",async()=>{
    const runtime=new Runtime();runtime.probes.set(4100,[false,true]);runtime.probes.set(4101,[true,true]);const events:unknown[]=[];
    const manager=new DevServiceManager(runtime,e=>events.push(e));const first=await manager.start(request);expect(first.state).toBe("starting");await new Promise(r=>setImmediate(r));
    expect(manager.status("web")?.state).toBe("ready");expect(manager.status("web")?.readyPorts).toEqual([4100,4101]);expect(events.length).toBeGreaterThan(2);
  });
  it("bounds logs and strips terminal controls",async()=>{
    const runtime=new Runtime();const manager=new DevServiceManager(runtime);await manager.start({...request,ports:[],assignment:{...request.assignment,ports:[]}});runtime.children[0]!.stdout.write(`\u001b[31m${"x".repeat(30000)}\u001b[0m\n`);
    const logs=manager.logs("web");expect(logs.length).toBeLessThanOrEqual(20000);expect(logs).not.toContain("\u001b");
  });
  it("refuses to kill a reused or malicious PID fingerprint",async()=>{
    const runtime=new Runtime();const manager=new DevServiceManager(runtime);await manager.start({...request,ports:[],assignment:{...request.assignment,ports:[]}});runtime.children[0]!.fingerprint="changed";
    await expect(manager.stop("web")).rejects.toThrow(/ownership/);expect(runtime.stopped).toEqual([]);
  });
  it("restart owns and stops the prior process tree before relaunch",async()=>{
    const runtime=new Runtime();const manager=new DevServiceManager(runtime);await manager.start({...request,ports:[],assignment:{...request.assignment,ports:[]}});const value=await manager.restart("web");expect(runtime.stopped).toEqual([100]);expect(value.run).toBe(2);
  });
  it("shutdown cleans every owned process",async()=>{
    const runtime=new Runtime();const manager=new DevServiceManager(runtime);await manager.start({...request,id:"web",ports:[],assignment:{...request.assignment,ports:[]}});await manager.start({...request,id:"api",ports:[],assignment:{...request.assignment,ports:[]}});await manager.shutdown();expect(runtime.stopped).toEqual([100,101]);
  });
  it("reconciles a missing or fingerprint-mismatched owned process as crashed without killing an unrelated PID",async()=>{
    const runtime=new Runtime();const manager=new DevServiceManager(runtime);await manager.start({...request,ports:[],assignment:{...request.assignment,ports:[]}});runtime.children[0]!.fingerprint="reused";
    expect((await manager.reconcile())[0]).toMatchObject({id:"web",state:"crashed",pid:null});expect(runtime.stopped).toEqual([]);
  });
  it("binds dev_server starts to declared services and rejects model-supplied launch authority",async()=>{
    const runtime=new Runtime();runtime.probes.set(4100,[true]);const manager=new DevServiceManager(runtime),tool=createDevServerToolAdapter(manager,{launchKey:"a".repeat(64),services:{web:{id:"web",executable:"npm",args:["run","dev"],cwd:"C:/repo",ports:[4100],assignment:{worktreeRoot:"C:/repo",ports:[4100]},executor:"host",environment:{WEB_URL:"http://localhost:4100"}}}});
    expect(tool.name).toBe("dev_server");await tool.execute({action:"start",id:"web"});expect(manager.status("web")).toMatchObject({ports:[4100]});
    await expect(tool.execute({action:"start",id:"web",executable:"node"} as never)).rejects.toThrow(/model-supplied|undeclared/);
    await expect(tool.execute({action:"start",id:"evil"})).rejects.toThrow(/undeclared/);
  });
  it("shares durable lifecycle state across manager instances",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-dev-state-")),runtime=new Runtime();
    await new DurableDevServiceManager(runtime,root).start({...request,ports:[],assignment:{...request.assignment,ports:[]}});
    expect(await new DurableDevServiceManager(runtime,root).status("web")).toMatchObject({id:"web",state:"ready",pid:100,fingerprint:"started:100"});
  });
  it("uses distinct atomic state temporaries across manager instances",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-dev-concurrent-state-")),runtime=new Runtime();
    const web=new DurableDevServiceManager(runtime,root),api=new DurableDevServiceManager(runtime,root);
    const results=await Promise.allSettled([
      web.start({...request,id:"web",ports:[],assignment:{...request.assignment,ports:[]}}),
      api.start({...request,id:"api",ports:[],assignment:{...request.assignment,ports:[]}}),
    ]);
    expect(results.map(result=>result.status)).toEqual(["fulfilled","fulfilled"]);
  });
  it("bounds retries for transient Windows atomic replacement contention",async()=>{
    let attempts=0,sleeps=0;
    await replaceAtomicFile("state.tmp","state.json",{platform:"win32",rename:async()=>{if(++attempts<3)throw Object.assign(new Error("busy"),{code:"EPERM"})},sleep:async()=>{sleeps++}});
    expect({attempts,sleeps}).toEqual({attempts:3,sleeps:2});
  });
  it("does not retry genuine atomic replacement errors",async()=>{
    let attempts=0;
    await expect(replaceAtomicFile("state.tmp","state.json",{platform:"win32",rename:async()=>{attempts++;throw Object.assign(new Error("disk failure"),{code:"EIO"})},sleep:async()=>{}})).rejects.toThrow("disk failure");
    expect(attempts).toBe(1);
  });
  it("reads durable logs without repeatedly inspecting an active OS process",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-dev-log-read-")),runtime=new Runtime();
    const manager=new DurableDevServiceManager(runtime,root);await manager.start({...request,ports:[],assignment:{...request.assignment,ports:[]}});
    await manager.logs("web");await manager.logs("web");
    expect(runtime.inspections).toBe(0);
  });
  it("reconciles stale durable process identity and bounds durable logs",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-dev-stale-")),runtime=new Runtime();
    await new DurableDevServiceManager(runtime,root).start({...request,ports:[],assignment:{...request.assignment,ports:[]}});runtime.children[0]!.fingerprint="reused";
    await writeFile(path.join(root,"web.log"),`${"old\n".repeat(600)}latest\n`);
    const next=new DurableDevServiceManager(runtime,root);expect(await next.status("web")).toMatchObject({state:"crashed",pid:null,lastError:expect.stringContaining("fingerprint")});
    const logs=await next.logs("web",{maxLines:2,maxCharacters:20});expect(logs).toContain("latest");expect(logs.length).toBeLessThanOrEqual(20);
  });
  it("turns readiness probe rejection into a crashed diagnostic",async()=>{
    const runtime=new Runtime();runtime.probe=async()=>{throw new Error("probe exploded")};
    const manager=new DevServiceManager(runtime);await manager.start({...request,ports:[4100],assignment:{...request.assignment,ports:[4100]}});await new Promise(r=>setImmediate(r));
    expect(await manager.status("web")).toMatchObject({state:"crashed",lastError:"Readiness probe failed: probe exploded"});
  });
  it("does not let an in-flight durable readiness probe overwrite an exited child",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-dev-race-")),runtime=new Runtime();let finishProbe!: (ready:boolean)=>void;
    runtime.probe=async()=>new Promise<boolean>(resolve=>{finishProbe=resolve});
    const manager=new DurableDevServiceManager(runtime,root);await manager.start({...request,ports:[4100],assignment:{...request.assignment,ports:[4100]}});
    await new Promise(r=>setImmediate(r));runtime.children[0]!.exit(9,null);await new Promise(r=>setImmediate(r));finishProbe(true);await new Promise(r=>setImmediate(r));
    expect(await manager.status("web")).toMatchObject({state:"crashed",pid:null,exitCode:9,readyAt:null});
  });
  it.skipIf(process.platform!=="win32"&&process.platform!=="linux")("reloads and safely controls an exact disposable OS child across managers (unsupported: durable process fingerprints require Windows or Linux)",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-dev-os-"));const first=new DurableDevServiceManager(createSystemRuntime(),root);let pid:number|undefined;
    try {
      const started=await first.start({...request,executable:"node",args:["-e","console.log('durable-ready');setInterval(()=>{},1000)"],cwd:root,ports:[],assignment:{worktreeRoot:root,ports:[]}});pid=started.pid??undefined;
      const fresh=new DurableDevServiceManager(createSystemRuntime(),root);expect(await fresh.status("web")).toMatchObject({state:"ready",pid,fingerprint:started.fingerprint});
      for(let i=0;i<20&&!(await fresh.logs("web")).includes("durable-ready");i++)await new Promise(r=>setTimeout(r,25));
      expect(await fresh.logs("web")).toContain("durable-ready");expect(await fresh.stop("web")).toMatchObject({state:"stopped",pid:null});expect(await fresh.reconcile()).toEqual([expect.objectContaining({state:"stopped",pid:null})]);
    } finally { if(pid)try{process.kill(pid,"SIGKILL")}catch{} await rm(root,{recursive:true,force:true,maxRetries:process.platform==="win32"?5:0,retryDelay:20}); }
  });
  it("rolling logs retain UTF-8 boundaries and latest carriage-return frame",()=>{const logs=new RollingLogBuffer({maxCharacters:20});logs.beginRun(1);logs.write("stdout",Buffer.from("old\rnew\n"));expect(logs.present()).toBe("new")});
});
