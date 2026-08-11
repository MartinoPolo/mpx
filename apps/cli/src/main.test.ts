import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MpxError, sha256Canonical, type JsonValue } from "@mpx/core";
import { run } from "./main.js";
import { captureIo } from "./io.js";

async function fixture(config:string):Promise<string>{
  const root=await mkdtemp(path.join(tmpdir(),"mpx-cli-"));
  await mkdir(path.join(root,".git")); await writeFile(path.join(root,"mpxconfig.json"),config);
  return root;
}
const valid=JSON.stringify({schemaVersion:1,project:{id:"sample"},repository:{provider:"generic",remote:"origin"}});

describe("cli",()=>{
  it("emits exactly one JSON document",async()=>{
    const cwd=await fixture(valid), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"config","validate"],io,{env:{}})).toBe(0);
    expect(io.err).toEqual([]); expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({apiVersion:1,ok:true,data:{valid:true}});
  });

  it("init is a no-write plan",async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),"mpx-init-")), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"init"],io,{env:{}})).toBe(0);
    await expect(readFile(path.join(cwd,"mpxconfig.json"),"utf8")).rejects.toThrow();
    expect(JSON.parse(io.out[0]!).data.plan.actions[0].type).toBe("create");
  });

  it("returns a stable sanitized malformed-config error",async()=>{
    const cwd=await fixture('{"secret":"do-not-print",'), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"config","validate"],io,{env:{}})).toBe(1);
    const text=io.out.join(""); const body=JSON.parse(text);
    expect(io.out).toHaveLength(1); expect(body).toMatchObject({apiVersion:1,ok:false,error:{code:"COMMAND_FAILED",retryable:false}});
    expect(text).not.toContain("do-not-print"); expect(text).not.toContain("stack");
  });

  it("explains the selected provider by role",async()=>{
    const cwd=await fixture(JSON.stringify({schemaVersion:1,project:{id:"sample"},repository:{provider:"github",remote:"origin"},issues:{provider:"none"}})), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"provider","explain","repository"],io,{env:{}})).toBe(0);
    const data=JSON.parse(io.out[0]!).data;
    expect(data).toMatchObject({role:"repository",provider:"github",adapter:"gh"});
    expect(data.capabilities.every((capability:string)=>!capability.startsWith("issue."))).toBe(true);
  });

  it("uses exit two for usage errors",async()=>{
    const io=captureIo();
    expect(await run(["--json","unknown"],io,{env:{}})).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USAGE_ERROR"}});
  });

  it("doctor reports a missing managed main reservation without allocating",async()=>{
    const config=JSON.stringify({schemaVersion:1,project:{id:"sample"},repository:{provider:"generic",remote:"origin"},development:{services:{app:{scope:"checkout",port:{mode:"managed",preferred:4173},start:{type:"package-script",script:"dev"}}}}});
    const cwd=await fixture(config), io=captureIo(); let ensured=false; let doctorRequest: {config: unknown; configHash: string}|undefined;
    const portService={resolve:async(request:{config:unknown;configHash:string})=>{doctorRequest=request;throw new MpxError({code:"PORT_LEASE_INVALID",message:"missing"});},ensure:async()=>{ensured=true;}} as never;
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"doctor"],io,{env:{},portService,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!).data.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:"PORT_LEASE_INVALID",severity:"error"})]));
    expect(ensured).toBe(false); expect(doctorRequest!.configHash).toBe(sha256Canonical(doctorRequest!.config as JsonValue));
  });

  it("doctor warns deterministically for fixed-shared services without requiring a reservation",async()=>{
    const config=JSON.stringify({schemaVersion:1,project:{id:"sample"},repository:{provider:"generic",remote:"origin"},development:{services:{app:{scope:"checkout",port:{mode:"fixed-shared",preferred:4173},start:{type:"package-script",script:"dev"}}}}});
    const cwd=await fixture(config), io=captureIo(); let resolved=false;
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"doctor"],io,{env:{},portService:{resolve:async()=>{resolved=true;}} as never,catalogRoot})).toBe(0);
    expect(io.out).toHaveLength(1); expect(JSON.parse(io.out[0]!).data.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:"FIXED_SHARED_LIMITATION",severity:"warning"})])); expect(resolved).toBe(false);
  });

  it("reports unavailable default state roots without touching user state",async()=>{
    const io=captureIo();
    expect(await run(["--json","ports","list"],io,{env:{}})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"STATE_ROOT_UNAVAILABLE"}});
  });

  it("sorts injected global leases and emits one envelope",async()=>{
    const io=captureIo();
    const leases=[{leaseId:"z"},{leaseId:"a"}] as never[];
    const portService={list:async()=>leases} as never;
    expect(await run(["--json","ports","list"],io,{env:{},portService})).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!).data.map((lease:{leaseId:string})=>lease.leaseId)).toEqual(["a","z"]);
  });

  it("delegates every read/write ports command with one envelope",async()=>{
    const cwd=await fixture(valid), calls:string[]=[], requests:unknown[]=[];
    const lease={leaseId:"lease",projectId:"sample",worktreeId:"worktree",configHash:"hash",services:{app:4173}};
    const portService={
      ensure:async(request:unknown)=>{calls.push("ensure");requests.push(request);return {lease,warnings:[{code:"FIXED_SHARED_DUPLICATE",message:"shared",port:4173}]};},
      resolve:async(request:unknown)=>{calls.push("resolve");requests.push(request);return lease;},
      inspect:async()=>{calls.push("inspect");return [];},
      release:async()=>{calls.push("release");},
      reconcile:async()=>{calls.push("reconcile");return {removed:[],repaired:[]};},
    } as never;
    for(const action of ["ensure","resolve","inspect","release","reconcile"]){
      const io=captureIo();
      expect(await run(["--json","--cwd",cwd,"ports",action],io,{env:{},portService})).toBe(0);
      expect(io.out).toHaveLength(1);
      expect(JSON.parse(io.out[0]!)).toMatchObject({apiVersion:1,ok:true});
    }
    expect(calls).toEqual(["ensure","resolve","inspect","release","reconcile"]);
    const discovered=JSON.parse(valid); for(const value of requests){const request=value as {config:unknown;configHash:string}; expect(request.config).toEqual(discovered); expect(request.configHash).toBe(sha256Canonical(discovered as JsonValue));}
    const changed={...discovered,repository:{...discovered.repository,remote:"changed"}}; expect(sha256Canonical(changed as JsonValue)).not.toBe(sha256Canonical(discovered as JsonValue));
  });

  it("delegates strict ports rebuild with known roots in one envelope",async()=>{
    const cwd=await fixture(valid), appdata=await mkdtemp(path.join(tmpdir(),"mpx-appdata-")), known=await mkdtemp(path.join(tmpdir(),"mpx-known-"));
    await mkdir(path.join(appdata,"mpx")); await writeFile(path.join(appdata,"mpx","config.json"),JSON.stringify({scopes:{personal:{roots:[known]}}}));
    let request:{roots:string[]}|undefined; const portService={rebuild:async(value:{roots:string[]})=>{request=value;return {discovered:1,rebuilt:1,roots:2}}} as never; const io=captureIo();
    expect(await run(["--json","--cwd",cwd,"ports","reconcile","--rebuild"],io,{env:{APPDATA:appdata},portService})).toBe(0);
    expect(request!.roots).toEqual([path.resolve(known),path.resolve(cwd)]);
    expect(io.out).toHaveLength(1); expect(JSON.parse(io.out[0]!)).toMatchObject({ok:true,data:{discovered:1,rebuilt:1,roots:2}});
  });

  it("rejects --rebuild on other ports commands as usage",async()=>{
    const io=captureIo();
    expect(await run(["--json","ports","list","--rebuild"],io,{env:{},portService:{list:async()=>[]} as never})).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USAGE_ERROR"}});
  });

  it("passes the full canonical config hash to status and changes it when config changes",async()=>{
    const cwd=await fixture(valid), requests:Array<{config:unknown;configHash:string}>=[];
    const statusProvider={snapshot:async(request:{config:unknown;configHash:string})=>{requests.push(request);return {schemaVersion:1,project:{id:"sample",cwd},worktree:{id:null,path:null,role:null,branch:null},portResolution:"missing",services:[],diagnostics:[]};}} as never;
    expect(await run(["--json","--cwd",cwd,"status"],captureIo(),{env:{},statusProvider})).toBe(0);
    const changed={...JSON.parse(valid),repository:{provider:"generic",remote:"changed"}}; await writeFile(path.join(cwd,"mpxconfig.json"),JSON.stringify(changed));
    expect(await run(["--json","--cwd",cwd,"status"],captureIo(),{env:{},statusProvider})).toBe(0);
    expect(requests[0]!.configHash).toBe(sha256Canonical(requests[0]!.config as JsonValue)); expect(requests[1]!.configHash).toBe(sha256Canonical(requests[1]!.config as JsonValue)); expect(requests[1]!.configHash).not.toBe(requests[0]!.configHash);
  });

  it("places fixed-shared diagnostics in envelope warnings",async()=>{
    const cwd=await fixture(valid), io=captureIo();
    const portService={ensure:async()=>({lease:{leaseId:"lease"},warnings:[{code:"FIXED_SHARED_DUPLICATE",message:"shared",port:4173}]})} as never;
    expect(await run(["--json","--cwd",cwd,"ports","ensure"],io,{env:{},portService})).toBe(0);
    expect(JSON.parse(io.out[0]!).warnings).toEqual([expect.objectContaining({code:"FIXED_SHARED_DUPLICATE",severity:"warning"})]);
  });

  it.each(["list","inspect"])("rejects extra arguments for ports %s",async(action)=>{
    const io=captureIo(), portService={list:async()=>[],inspect:async()=>[]} as never;
    expect(await run(["--json","ports",action,"extra"],io,{env:{},portService})).toBe(2);
  });

  it("routes a validated positional PID through PortService.kill",async()=>{
    const io=captureIo(); let killed:number|undefined;
    const portService={kill:async(pid:number)=>{killed=pid}} as never;
    expect(await run(["--json","ports","kill","42"],io,{env:{},portService})).toBe(0);
    expect(killed).toBe(42);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:true,data:{killed:true,pid:42},warnings:[]});
  });

  it("rejects ambiguous PID syntax",async()=>{
    const io=captureIo(); const portService={kill:async()=>undefined} as never;
    expect(await run(["--json","ports","kill","42","--pid","42"],io,{env:{},portService})).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USAGE_ERROR"}});
  });
});
