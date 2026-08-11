import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
