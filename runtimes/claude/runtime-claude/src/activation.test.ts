import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createRuntimeCapabilityManifestV1, type ToolAuthorityV1 } from "@mpx/runtime-contracts";
import { activateClaudePluginRuntime } from "./index.js";

const launchKey = "a".repeat(64);
const authority = (name:string,routes:string[]=[],destinations:string[]=[]):ToolAuthorityV1 => ({schemaVersion:1,name,executors:["host"],routes,network:{mode:destinations.length?"allow-list":"deny-all",destinations},paidCredits:{allowed:false,maxCredits:0},input:{maxBytes:100000},output:{maxBytes:100000},timeout:{maxMs:5000},cache:{mode:"read-write",maxBytes:100000}});

it("activates the generated Claude surface with launch-bound gateway, dev-service, live status, and cleanup authority", async () => {
  const base = JSON.parse(await readFile(new URL("../../../../packages/status/fixtures/runtime-claude-personal.json", import.meta.url), "utf8"));
  base.binding = { launchKey, runtimeId: "claude", repositoryId: "repo" };
  base.actions.items.push({ id:"show-tasks",enabled:true,narrowLabel:"Tsk",wideLabel:"Task panel" },{ id:"open-review",enabled:true,narrowLabel:"PR",wideLabel:"Review #42" },{ id:"show-ci",enabled:true,narrowLabel:"CI",wideLabel:"CI passing" });
  const changed = structuredClone(base); changed.development.services = [{id:"web",state:"listening",port:4100}];
  const registered = new Map<string,(input:any)=>Promise<unknown>>(), events:unknown[] = [], processCalls:unknown[]=[];
  const closed = Promise.resolve({code:0,signal:null});
  const runtimeAdapter = {kind:"host" as const,now:()=>"2026-01-01T00:00:00.000Z",sleep:async()=>{},probe:async()=>true,inspect:async(pid:number)=>({pid,fingerprint:"owned"}),stop:vi.fn(async()=>{}),spawn:vi.fn(async()=>({pid:42,fingerprint:"owned",stdout:new PassThrough(),stderr:new PassThrough(),closed,onClose:()=>{}}))};
  let live:unknown=changed;
  const activated = activateClaudePluginRuntime({
    register:(name,execute)=>registered.set(name,execute), publish:event=>events.push(event),
    capability:createRuntimeCapabilityManifestV1({runtime:"claude",launchKey,identity:{name:"personal",domain:"personal",nativeRuntimeRootDigest:"b".repeat(64)},binding:{projectId:"app",repositoryId:"repo",contentScope:"personal"},executor:"host",tools:[authority("mcp",["mcp:fixture"]),authority("web_search",["web:personal"],["search.example"]),authority("fetch_content",["web:personal"],["search.example"]),authority("get_search_content"),authority("source_check",["web:personal"],["search.example"])],routes:["mcp:fixture","web:personal"],resources:[],mounts:[],destinations:["search.example"],skills:[],models:[],nesting:{depth:0,maxDepth:0}}),
    executor:{name:"host",resolveDns:async()=>["203.0.113.10"],requestNetwork:async()=>({status:200,headers:{},body:""}),executeProcess:async request=>{processCalls.push(request);return {output:{launch:launchKey,method:request.method}}}},
    mcpRoutes:{fixture:{kind:"process",executable:"C:/trusted/fixture.exe",argv:[]}}, providers:[{id:"fixture-web",route:"web:personal",destination:"search.example",paidCredits:0,fallbackOnly:false,search:async({query})=>({results:[{title:query,url:"https://search.example/result",snippet:"ok"}]}),fetch:async()=>({content:"fixture"})}],
    devServer:{executor:"host",worktreeRoot:"C:/repo",assignedPorts:[4100],runtimeAdapter},
    status:{binding:base.binding,initial:base,reader:{read:async()=>live}},
  });
  expect([...registered.keys()].sort()).toEqual(["dev_server","fetch_content","get_search_content","mcp","source_check","web_search"]);
  await expect(registered.get("mcp")!({serverId:"fixture",method:"tools/call",params:{}})).resolves.toMatchObject({output:{launch:launchKey}});
  expect(processCalls[0]).toMatchObject({method:"tools/call"});
  await expect(registered.get("web_search")!({query:"authority"})).resolves.toMatchObject({provider:"fixture-web"});
  await registered.get("dev_server")!({action:"start",id:"web",executable:"node",args:[],cwd:"C:/repo",ports:[4100]});
  expect(runtimeAdapter.spawn).toHaveBeenCalledWith(expect.objectContaining({cwd:"c:/repo",ports:[4100]}));
  await activated.status.refresh();
  const line=activated.status.render({launchBanner:"[mpx claude/host abc]"});
  for(const text of ["web:4100*","Task panel","Review #42","CI passing"])expect(line).toContain(text);
  live={...changed,binding:{...changed.binding,repositoryId:"other"}}; await activated.status.refresh();
  expect(activated.status.current()!.development.freshness.state).toBe("stale");
  expect(activated.status.render({launchBanner:"[mpx claude/host abc]"})).toContain("Task panel");
  await activated.shutdown();
  expect(runtimeAdapter.stop).toHaveBeenCalled();
  expect(events).toContainEqual({type:"runtime-tools:shutdown",launchKey});
});
