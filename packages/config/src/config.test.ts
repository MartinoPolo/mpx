import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {describe,expect,it} from "vitest";import {parseStrictJson,StrictJsonError} from "./strict-json.js";import {assertValid,validateProject} from "./schema.js";import {parseUserConfig} from "./user-config.js";import {confirmInit,planInit} from "./init.js";
const base=(provider="github")=>({schemaVersion:1,project:{id:"acme/app"},repository:{provider,remote:"origin"}});
describe("closed project schema",()=>{it.each(["github","gitlab","gerrit","generic"])("accepts %s",p=>expect(()=>assertValid(validateProject,base(p))).not.toThrow());it("accepts kanban",()=>expect(()=>assertValid(validateProject,{...base(),issues:{provider:"kanbanflow",boardId:"b",states:{todo:"1",wip:"2",review:"3",done:"4"}}})).not.toThrow());it.each([{...base(),extra:1},{...base(),schemaVersion:2},{...base("jira")}])("rejects unknown",x=>expect(()=>assertValid(validateProject,x)).toThrow());it("rejects launch defaults",()=>expect(()=>assertValid(validateProject,{...base(),launchDefaults:{scopes:{},projects:{}}})).toThrow());it.each(["../app","owner//app","owner/app/extra"])("rejects unsafe project ID %s",id=>expect(()=>assertValid(validateProject,{...base(),project:{id}})).toThrow())});
it("rejects empty or duplicate preparation dependencies",()=>{
  const config={...base(),worktrees:{postCreate:{execution:"foreground",steps:[{id:"",uses:"package-install",dependsOn:["build","build"]}]}}};
  expect(()=>assertValid(validateProject,config)).toThrow();
});
describe("strict json",()=>{it.each(['{"a":1,"a":2}','{"__proto__":1}','{"nested":{"constructor":1}}'])("rejects malicious %s",s=>expect(()=>parseStrictJson(s)).toThrow(StrictJsonError));it("schema rejects secret fields",()=>expect(()=>assertValid(validateProject,{...base(),token:"secret"})).toThrow())});
const user=(root:string,pack="core")=>JSON.stringify({identities:{},domains:{work:[root]},contentScopes:{work:{roots:[root],skillPacks:[pack]}},modes:{},skillPolicies:{},presets:{},launchDefaults:{scopes:{},projects:{}},networkPolicies:{},executors:{host:{}}});
it("interpolates only approved complete MPX root tokens",()=>{
  expect(parseUserConfig(user("${MPX_WORK}"),{MPX_WORK:"C:/work"}).contentScopes.work?.roots).toEqual(["C:/work"]);
  expect(()=>parseUserConfig(user("x/${MPX_WORK}"),{MPX_WORK:"C:/work"})).toThrow();
  expect(()=>parseUserConfig(user("${MPX_SECRET}"),{MPX_SECRET:"secret"})).toThrow();
});
it("rejects unknown skill packs",()=>expect(()=>parseUserConfig(user("C:/work","unknown"))).toThrow());
it("requires a preferred port for fixed-shared services",()=>{
  const service={scope:"checkout",port:{mode:"fixed-shared"},start:{type:"package-script",script:"dev"}};
  expect(()=>assertValid(validateProject,{...base(),development:{services:{app:service}}})).toThrow();
});
it("accepts bounded family identifiers and rejects unsafe ones",()=>{
  const service=(family:string)=>({scope:"checkout",port:{mode:"managed",preferred:4173,family},start:{type:"package-script",script:"dev"}});
  expect(()=>assertValid(validateProject,{...base(),development:{services:{app:service("web.preview")}}})).not.toThrow();
  expect(()=>assertValid(validateProject,{...base(),development:{services:{app:service("../web")}}})).toThrow();
});
it("init is deterministic and read-only",()=>expect(planInit("C:/repo",false)).toEqual(planInit("C:/repo",false)));
it("confirmed init applies its plan byte-idempotently",async()=>{
  const cwd=await mkdtemp(path.join(tmpdir(),"mpx-config-init-"));
  const manifest={schemaVersion:1 as const,project:{id:"sample/app"},repository:{provider:"generic",remote:"REPLACE_ME"}};
  try {
    const first=await confirmInit(cwd,false,manifest); const bytes=await readFile(path.join(cwd,"mpxconfig.json"),"utf8");
    const second=await confirmInit(cwd,true,manifest);
    expect(first.plan.actions[0]?.type).toBe("create"); expect(second.plan.actions[0]?.type).toBe("skip");
    expect(await readFile(path.join(cwd,"mpxconfig.json"),"utf8")).toBe(bytes);
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
