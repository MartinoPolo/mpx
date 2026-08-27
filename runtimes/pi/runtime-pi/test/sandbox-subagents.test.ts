import { describe, expect, it, vi } from "vitest";
import { createRuntimeCapabilityManifestV1 } from "@mpx/runtime-contracts";
import { createProjectionSubagentRuntime } from "../src/production-subagents.js";
const h=(c:string)=>c.repeat(64);
const tool=(name:string)=>({schemaVersion:1 as const,name,executors:["docker" as const],routes:[],network:{mode:"deny-all" as const,destinations:[]},paidCredits:{allowed:false,maxCredits:0},input:{maxBytes:4096},output:{maxBytes:4096},timeout:{maxMs:1000},cache:{mode:"disabled" as const,maxBytes:0}});
const parent=createRuntimeCapabilityManifestV1({runtime:"pi",launchKey:h("a"),identity:{name:"work",domain:"work",nativeRuntimeRootDigest:h("b")},binding:{projectId:"p",repositoryId:"r",contentScope:"work"},executor:"docker",tools:[tool("read"),tool("Agent")],routes:[],resources:[],mounts:[],destinations:[],skills:[],models:[],nesting:{depth:0,maxDepth:2}});
describe("sandbox child authority",()=>{
 it("preserves the same handle for grouped children and denies widening or excess nesting",async()=>{const execute=vi.fn(async()=>"remote child");const runtime=createProjectionSubagentRuntime(parent,{execute});await runtime.launch({id:"a",prompt:"one",join:"group",groupId:"g",tools:["read"]});expect(execute).toHaveBeenCalledWith("Agent/child",expect.objectContaining({groupId:"g",authority:expect.objectContaining({executor:"docker",tools:["read"],nesting:{depth:1,maxDepth:2}})}));await expect(runtime.launch({id:"b",prompt:"two",tools:["write"]})).rejects.toThrow(/WIDENING/u);await runtime.shutdown();});
});
