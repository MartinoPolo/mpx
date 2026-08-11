import {describe,expect,it} from "vitest";import {parseStrictJson,StrictJsonError} from "./strict-json.js";import {assertValid,validateProject} from "./schema.js";import {parseUserConfig} from "./user-config.js";import {planInit} from "./init.js";
const base=(provider="github")=>({schemaVersion:1,project:{id:"acme/app"},repository:{provider,remote:"origin"}});
describe("closed project schema",()=>{it.each(["github","gitlab","gerrit","generic"])("accepts %s",p=>expect(()=>assertValid(validateProject,base(p))).not.toThrow());it("accepts kanban",()=>expect(()=>assertValid(validateProject,{...base(),issues:{provider:"kanbanflow",boardId:"b",states:{todo:"1",wip:"2",review:"3",done:"4"}}})).not.toThrow());it.each([{...base(),extra:1},{...base(),schemaVersion:2},{...base("jira")}])("rejects unknown",x=>expect(()=>assertValid(validateProject,x)).toThrow())});
it("rejects empty or duplicate preparation dependencies",()=>{
  const config={...base(),worktrees:{postCreate:{execution:"foreground",steps:[{id:"",uses:"package-install",after:["build","build"]}]}}};
  expect(()=>assertValid(validateProject,config)).toThrow();
});
describe("strict json",()=>{it.each(['{"a":1,"a":2}','{"__proto__":1}','{"nested":{"constructor":1}}'])("rejects malicious %s",s=>expect(()=>parseStrictJson(s)).toThrow(StrictJsonError));it("schema rejects secret fields",()=>expect(()=>assertValid(validateProject,{...base(),token:"secret"})).toThrow())});
it("interpolates only approved complete MPX root tokens",()=>{
  expect(parseUserConfig('{"scopes":{"x":{"roots":["${MPX_WORK}"]}}}',{MPX_WORK:"C:/work"}).scopes.x?.roots).toEqual(["C:/work"]);
  expect(()=>parseUserConfig('{"scopes":{"x":{"roots":["x/${MPX_WORK}"]}}}',{MPX_WORK:"C:/work"})).toThrow();
  expect(()=>parseUserConfig('{"scopes":{"x":{"roots":["${MPX_SECRET}"]}}}',{MPX_SECRET:"secret"})).toThrow();
});
it("rejects unknown skill packs",()=>expect(()=>parseUserConfig('{"scopes":{"x":{"roots":["C:/work"],"skillPacks":["unknown"]}}}')).toThrow());
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
