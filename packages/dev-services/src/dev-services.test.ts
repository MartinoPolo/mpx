import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DevServiceManager, RollingLogBuffer, assertExecutorBoundary, createDevServerToolAdapter, validateStartRequest, type ManagedProcess, type RuntimeAdapter } from "./index.js";

class Child extends EventEmitter implements ManagedProcess {
  stdout=new PassThrough(); stderr=new PassThrough(); fingerprint="started:100"; closed:Promise<{code:number|null;signal:string|null}>; resolve!: (v:{code:number|null;signal:string|null})=>void;
  constructor(readonly pid:number){ super(); this.closed=new Promise(r=>this.resolve=r); }
  exit(code:number|null=0,signal:string|null=null){const e={code,signal};this.emit("close",e);this.resolve(e)}
  onClose(fn:(e:{code:number|null;signal:string|null})=>void){this.on("close",fn)}
}
class Runtime implements RuntimeAdapter {
  kind="host" as const; children:Child[]=[]; probes=new Map<number,boolean[]>(); stopped:number[]=[]; tick=0;
  now=()=>new Date(1700000000000+this.tick++).toISOString(); sleep=async()=>{};
  spawn=()=>{const c=new Child(100+this.children.length);this.children.push(c);return c};
  probe=async(port:number)=>this.probes.get(port)?.shift()??false;
  inspect=async(pid:number)=>({pid,fingerprint:this.children.find(c=>c.pid===pid)?.fingerprint??"other"});
  stop=async(c:ManagedProcess)=>{this.stopped.push(c.pid);(c as Child).exit(null,"SIGTERM")};
}
const request={id:"web",command:"npm run dev",cwd:"C:/repo",ports:[4100,4101],assignment:{worktreeRoot:"C:/repo",ports:[4100,4101]},executor:"host" as const};

describe("managed development services",()=>{
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
  it("exposes an isolated launch-bound dev_server adapter without weakening executor or port binding",async()=>{
    const runtime=new Runtime();runtime.probes.set(4100,[true]);const manager=new DevServiceManager(runtime),tool=createDevServerToolAdapter(manager,{launchKey:"a".repeat(64),executor:"host",cwd:"C:/repo",assignment:{worktreeRoot:"C:/repo",ports:[4100]}});
    expect(tool.name).toBe("dev_server");await tool.execute({action:"start",id:"web",command:"npm run dev",ports:[4100]});expect(manager.status("web")).toMatchObject({ports:[4100]});
    await expect(tool.execute({action:"start",id:"evil",command:"x",ports:[9999]})).rejects.toThrow(/assigned/);
  });
  it("rolling logs retain UTF-8 boundaries and latest carriage-return frame",()=>{const logs=new RollingLogBuffer({maxCharacters:20});logs.beginRun(1);logs.write("stdout",Buffer.from("old\rnew\n"));expect(logs.present()).toBe("new")});
});
