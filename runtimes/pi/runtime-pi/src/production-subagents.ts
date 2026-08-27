import { SubagentLifecycle, bindChildLaunchAuthority, type AgentLaunchRequest } from "@mpx/subagents";
import type { ChildLaunchAuthorityV1, RuntimeCapabilityManifestV1 } from "@mpx/runtime-contracts";
import { evaluateFallowGate, evaluatePackagePolicy, evaluatePreCommit, extractPostCommandContext, planCompactionInjection, planFileQuality, planNotification, planSessionContext } from "@mpx/runtime-hooks";
import { parseRuntimeStatusEnvelopeV1 } from "@mpx/status";

const environment = { packageManager: "pnpm" as const, runner: ["pnpm", "exec"] as const, toolchain: "classic" as const, framework: null, python: false };
export const projectionRuntimePolicies = Object.freeze({
  parseStatus: parseRuntimeStatusEnvelopeV1, session: () => planSessionContext(process.env),
  toolCall(input: Record<string, unknown>) { const command=String(input.command??"");const packageDecision=evaluatePackagePolicy(command,environment.packageManager);if(packageDecision.action==="block")return packageDecision;const precommit=evaluatePreCommit({command,packageManager:environment.packageManager,toolchain:environment.toolchain,framework:environment.framework,scripts:{},staged:Array.isArray(input.staged)?input.staged as Array<{file:string;diff:string}>:[]});if(precommit.action==="block")return precommit;const fallow=evaluateFallowGate({command,minimumVersion:"2.46.0",...(input.fallow&&typeof input.fallow==="object"?{runner:{description:"fallow",version:"2.46.0"},audit:{stdout:"",stderr:"",...(input.fallow as {status:number})}}:{})});return fallow.warning?{action:"allow" as const,warning:fallow.warning}:{action:"allow" as const}; },
  postWrite:(file:string)=>planFileQuality({relativeFile:file,toolchain:environment.toolchain,runner:environment.runner,configs:[]}),
  postCommand:(command:string,stderr:string)=>extractPostCommandContext({operation:"package-install",exitCode:0,stderr:/(?:npm|pnpm|yarn|bun)\s+(?:install|add)/u.test(command)?stderr:""}),
  compact:(manualInstructions:string)=>planCompactionInjection({manualInstructions,canonicalInstructions:"Preserve immutable launch authority.",environment}),
  notification:()=>planNotification({event:"turn-settled",platform:process.platform,sessionRole:"top-level"}),
});
export interface ProjectionSubagentRuntime { launch(params:Record<string,unknown>):Promise<unknown>;result(id:string):Promise<string>;steer(id:string,message:string):void;list():readonly unknown[];shutdown():Promise<void> }
interface ChildRemote { execute(path:string,input:unknown):Promise<unknown> }

/** Child work uses the parent's launch-bound remote handle. Authority can only be narrowed. */
export function createProjectionSubagentRuntime(parent?: RuntimeCapabilityManifestV1, remote?: ChildRemote): ProjectionSubagentRuntime {
  const runner={async run(request:AgentLaunchRequest):Promise<string>{
    if(parent?.executor==="docker") { if(!remote)throw new Error("SUBAGENT_REMOTE_EXECUTOR_REQUIRED");const result=await remote.execute("Agent/child",request);return typeof result==="string"?result:JSON.stringify(result); }
    return `@mpx/subagents approved host runner completed: ${request.prompt}`;
  }};
  const lifecycle=new SubagentLifecycle({concurrency:4,runner});
  const authority=(params:Record<string,unknown>):ChildLaunchAuthorityV1=>{
    if(!parent)throw new Error("SUBAGENT_AUTHORITY_REQUIRED");
    const requested=Array.isArray(params.tools)?params.tools.map(String):parent.tools.map(tool=>tool.name);
    return bindChildLaunchAuthority(parent,{schemaVersion:1,parentManifestKey:parent.manifestKey,parentLaunchKey:parent.launchKey,runtime:parent.runtime,identity:parent.identity,binding:parent.binding,executor:parent.executor,tools:requested,routes:parent.routes,resources:parent.resources,mounts:parent.mounts,destinations:parent.destinations,skills:parent.skills,models:parent.models,nesting:{depth:parent.nesting.depth+1,maxDepth:parent.nesting.maxDepth}});
  };
  return {async launch(params){const id=String(params.id??"").trim(),prompt=String(params.prompt??"").trim();if(!id||!prompt)throw new Error("SUBAGENT_INPUT_INVALID");const childAuthority=authority(params);const request:AgentLaunchRequest={id,type:"task",identity:childAuthority.identity.name,description:prompt,prompt,join:params.join==="foreground"?"foreground":params.join==="group"?"group":"background",...(typeof params.groupId==="string"?{groupId:params.groupId}:{}),model:{provider:"projection",model:"launch-bound"},nesting:{depth:childAuthority.nesting.depth,maxDepth:childAuthority.nesting.maxDepth,parentAgentId:null,rootAgentId:id},authority:childAuthority};return lifecycle.launch(request);},result:id=>lifecycle.get_subagent_result(id),steer:(id,message)=>lifecycle.steer_subagent(id,message),list:()=>lifecycle.list(),async shutdown(){await lifecycle.shutdown();}};
}
