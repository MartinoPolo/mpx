#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigValidationError,
  StrictJsonError,
  confirmInit,
  discoverProjectConfig,
  rollbackConfirmedInit,
  doctor as configDoctor,
  loadUserConfig,
  planInit,
  resolveConfig,
  resolveEffectiveSkillPacks,
  resolveKnownLaunchCwdClassification,
  type DiscoveredConfig,
  type ProjectConfig,
  type UserConfig,
} from "@mpx/config";
import { createSkillArtifactReference, errorEnvelope, MpxError, sha256Canonical, successEnvelope, type Diagnostic, type JsonValue } from "@mpx/core";
import { resolveLaunch, resolveLaunchSelection, serializeLaunchPublic, type ResolveLaunchSelectionInput, type ShortLaunchAlias } from "@mpx/launch";
import { ExecutionError, sanitizeHostReason } from "@mpx/executors";
import { probeProvider, type ProviderRegistry } from "@mpx/providers";
import { parseStatusSnapshotV1, type StatusSnapshotV1 } from "@mpx/status";
import { expandBranchTemplate } from "@mpx/worktrees";
import { createRuntimeSkillArtifact, explainSkill, humanCompleteSkills, humanListSkills, humanSearchSkills, humanSkillDetail, inventoryCanonical, inventoryProjectSkills, resolveManifest, searchSkills, SkillCatalogError, doctor as skillDoctor, type ResolveOptions } from "@mpx/skills";
import { catalogPath, configuredProviderRegistry, createDefaultSbxDiagnostics, defaultContext, executeInternalPreparationWorker, NodeProviderProcessExecutor, ports, providerService, status, worktrees, type CliContext } from "./context.js";
import { currentLaunchTuple, directProcessTty, executeResolvedLaunch, executionMpxError, executorEvidence } from "./launch-execution.js";
import { processIo, type CliIo } from "./io.js";
import { defaultDevService, executeDevCommand } from "./dev-command.js";

interface Parsed { command: string[]; cwd: string; json: boolean; options: Map<string,string|boolean|string[]> }
interface ExecuteResult { data: unknown; warnings: Diagnostic[]; exitCode?: number; machinePath?: string; silent?: boolean }
class UsageError extends Error {}
const usage = "Usage: mpx [--cwd DIR] [--json] <init [--confirm]|config|doctor|provider|skill|identity|mode|skill-policy|preset|launch|issue|review|ci|status|ports|dev start|status|logs|restart|stop|worktree create|remove|list|select|status|prepare|cancel|reconcile>";

const shortLaunchAliases = new Set<ShortLaunchAlias>(["cc", "ccw", "pi", "piw"]);
function parse(argv: readonly string[]): Parsed {
  const words: string[] = [], options = new Map<string,string|boolean|string[]>();
  for (let i=0;i<argv.length;i++) {
    const word=argv[i]!;
    if (!word.startsWith("--")) { words.push(word); continue; }
    const [name,inline]=word.slice(2).split("=",2);
    if (["json","rebuild","confirm","machine","cancel"].includes(name!)) options.set(name!,true);
    else if (["cwd","role","limit","lines","artifact-key","pid","identity","skill-policy","runtime","content-scope","mode","executor","workspace","network-policy","preset","reason","grant","base","template","slug","author","issue","execution","approval","package-approval","explicit-executable-approval","include-approval","orphan-approval","path","source","id","title","body","label","destination","source-branch","target-branch","method","run-id","state"].includes(name!)) {
      const value=inline ?? argv[++i]; if (!value || value.startsWith("--")) throw new UsageError(`--${name} requires a value`);
      if (name==="grant") options.set(name,[...((options.get(name) as string[]|undefined)??[]),value]);
      else options.set(name!,value);
    } else throw new UsageError(`Unknown option: --${name}`);
  }
  const command = words.length === 1 && shortLaunchAliases.has(words[0] as ShortLaunchAlias) ? ["launch", words[0]!] : words;
  return { command, cwd:path.resolve(String(options.get("cwd")??process.cwd())), json:options.get("json")===true, options };
}
function safeErrnoCode(error:unknown):string{
  const code=typeof error==="object" && error!==null && "code" in error ? (error as {code?:unknown}).code : undefined;
  return typeof code==="string" && code ? code : "UNKNOWN";
}
function userConfigUnreadable(error:unknown):MpxError{
  return new MpxError({code:"USER_CONFIG_UNREADABLE",message:"User configuration could not be read.",details:{errno:safeErrnoCode(error)}});
}
async function present(file:string, accessFile:(file:string)=>Promise<void>=access):Promise<boolean>{
  try{await accessFile(file);return true;}catch(error){const code=safeErrnoCode(error);if(code==="ENOENT" || code==="ENOTDIR") return false;throw userConfigUnreadable(error);}
}
async function readUserConfig(file:string, context:CliContext):Promise<UserConfig>{
  try{return await loadUserConfig(file,context.env);}catch(error){if(error instanceof StrictJsonError || error instanceof ConfigValidationError || error instanceof MpxError) throw error;throw userConfigUnreadable(error);}
}
function emptyUserConfig():UserConfig { return { identities:{}, domains:{}, contentScopes:{}, modes:{}, skillPolicies:{}, presets:{}, launchDefaults:{projects:{},scopes:{}}, networkPolicies:{}, executors:{host:{}} }; }
async function userConfig(context:CliContext):Promise<UserConfig>{
  const appdata=context.env.APPDATA;
  if (!appdata) return emptyUserConfig();
  const file=path.join(appdata,"mpx","config.json");
  return await present(file,context.accessFile) ? readUserConfig(file,context) : emptyUserConfig();
}
async function requiredUserConfig(context:CliContext):Promise<UserConfig>{
  const appdata=context.env.APPDATA;
  if (!appdata || !path.isAbsolute(appdata)) throw new MpxError({code:"USER_CONFIG_REQUIRED",message:"Launch-bound commands require strict user-local configuration.",remediation:"Create %APPDATA%/mpx/config.json and set APPDATA to an absolute path."});
  const file=path.join(appdata,"mpx","config.json");
  if (!await present(file,context.accessFile)) throw new MpxError({code:"USER_CONFIG_REQUIRED",message:"Launch-bound commands require strict user-local configuration.",remediation:"Create %APPDATA%/mpx/config.json."});
  return readUserConfig(file,context);
}
async function project(parsed:Parsed):Promise<DiscoveredConfig>{
  const found=await discoverProjectConfig(parsed.cwd);
  if (!found) throw new MpxError({code:"CONFIG_NOT_FOUND",message:"No mpxconfig.json was found.",remediation:"Run 'mpx init' in the project root."});
  return found;
}

function stringOption(parsed:Parsed,name:string):string|undefined {
  const value=parsed.options.get(name); return typeof value==="string"?value:undefined;
}
function requiredOption(parsed:Parsed,name:string):string {
  const value=stringOption(parsed,name); if(value===undefined) throw new UsageError(`--${name} is required`); return value;
}
async function providerBinding(parsed:Parsed,context:CliContext,role:"repository"|"issues",capability:string) {
  const found=await project(parsed);
  const providerId=role==="repository" ? found.config.repository.provider : found.config.issues?.provider??"none";
  const identityName=stringOption(parsed,"identity");
  if(identityName===undefined) throw new MpxError({code:"IDENTITY_REQUIRED",message:"Provider commands require an explicit identity."});
  const user=await requiredUserConfig(context), identity=user.identities[identityName];
  if(!identity) throw new MpxError({code:"IDENTITY_UNKNOWN",message:`Unknown identity '${identityName}'.`});
  const registry:ProviderRegistry=configuredProviderRegistry(context);
  registry.assertCapability(providerId,capability);
  const route=identity.providerRoutes?.[providerId];
  if(!route) throw new MpxError({code:"PROVIDER_ROUTE_REQUIRED",message:`Identity '${identityName}' has no route for provider '${providerId}'.`,remediation:"Configure identity.providerRoutes for the selected provider."});
  return {found,providerId,route};
}

async function knownCwdClassification(cwd:string, user:UserConfig):Promise<{domain:string; contentScope:string}>{
  return resolveKnownLaunchCwdClassification(cwd, user);
}

function resolveOptions(
  user:UserConfig,
  binding:{identity:string;skillPolicy:string;contentScope:string;repositoryId:string;projectId?:string},
):ResolveOptions {
  const configuredScope=user.contentScopes[binding.contentScope];
  if (!configuredScope) throw new MpxError({code:"CONTENT_SCOPE_UNKNOWN",message:`Unknown content scope '${binding.contentScope}'.`});
  const skillPolicyConfig=user.skillPolicies[binding.skillPolicy];
  if (!skillPolicyConfig) throw new MpxError({code:"SKILL_POLICY_UNKNOWN",message:`Unknown skill policy '${binding.skillPolicy}'.`});
  const projectOverride=binding.projectId ? user.projects?.[binding.projectId] : undefined;
  const contentScopeExposure=configuredScope.skillExposure ?? {};
  const projectExposure=projectOverride?.skillExposure;
  return {
    repositoryId:binding.repositoryId,
    contentScope:binding.contentScope,
    ...(binding.projectId ? {projectId:binding.projectId} : {}),
    enabledPacks:resolveEffectiveSkillPacks({
      contentScopeSkillPacks:configuredScope.skillPacks,
      projectSkillPacks:projectOverride?.skillPacks,
      skillPolicySkillPacks:skillPolicyConfig.skillPacks,
    }),
    identity:binding.identity,
    skillPolicy:binding.skillPolicy,
    skillPolicyConfig,
    contentScopeExposure,
    ...(projectExposure ? {projectExposure} : {}),
  };
}

function sanitizePublicMessage(message:string):string {
  return message.replace(/[\r\n\t]+/gu," ").trim().replace(/[A-Za-z]:[\\/][^\s,;]+/gu,"[path]").replace(/(^|[\s(])\/[^\s,;)]+/gu,"$1[path]").slice(0,256);
}

function invalidConfigError():MpxError {
  return new MpxError({code:"CONFIG_INVALID",message:"Configuration is invalid."});
}

function normalizeConfigError(error:ConfigValidationError):MpxError {
  return new MpxError({
    code:"CONFIG_INVALID",
    message:"Configuration is invalid.",
    details:{errors:error.errors.map(({ instancePath, keyword }) => ({ pointer: instancePath || "/", keyword }))},
  });
}

function human(value:unknown):string {
  if (Array.isArray(value)) return value.map(item=>typeof item==="string"?item:JSON.stringify(item)).join("\n")+"\n";
  if (typeof value==="string") return value+"\n";
  return JSON.stringify(value,null,2)+"\n";
}
function asJson(value:unknown):JsonValue { return value as JsonValue }

async function execute(parsed:Parsed, context:CliContext):Promise<ExecuteResult> {
  const [group,action,...args]=parsed.command;
  if (!group) throw new UsageError(usage);
  if (parsed.options.get("rebuild") === true && (group !== "ports" || action !== "reconcile")) throw new UsageError("--rebuild is valid only for ports reconcile");
  if (parsed.options.get("confirm") === true && (group !== "init" || action !== undefined)) throw new UsageError("--confirm is valid only for init");
  let data: unknown;
  let warnings: Diagnostic[] = [];
  if (["identity","mode","skill-policy","preset"].includes(group) && ["list","show"].includes(action ?? "")) {
    const user=await requiredUserConfig(context);
    const source=group==="identity" ? user.identities : group==="mode" ? user.modes : group==="skill-policy" ? user.skillPolicies : user.presets;
    const projectPublic=(name:string,value:unknown):unknown=>{
      if (group!=="identity") return {name,...(value as Record<string,unknown>)};
      const identity=value as UserConfig["identities"][string];
      return {name,domain:identity.domain,gitAuthorRoute:identity.gitAuthorRoute,providerRoutes:Object.fromEntries(Object.entries(identity.providerRoutes??{}).sort(([left],[right])=>left.localeCompare(right))),sshRoute:identity.sshRoute??null,mcpSharing:{allow:[...(identity.mcpSharing?.allow??[])].sort(),shareNativeAuth:false}};
    };
    if (action==="list") {
      if (args.length) throw new UsageError(`${group} list accepts no arguments`);
      data={schemaVersion:1,kind:group,items:Object.entries(source).sort(([left],[right])=>left.localeCompare(right)).map(([name,value])=>projectPublic(name,value))};
    } else {
      if (args.length!==1) throw new UsageError(`${group} show requires exactly one name`);
      const name=args[0]!, value=source[name];
      if (!value) throw new MpxError({code:`${group.replace("-","_").toUpperCase()}_UNKNOWN`,message:`Unknown ${group} '${name}'.`});
      data={schemaVersion:1,kind:group,item:projectPublic(name,value)};
    }
    return {data,warnings};
  }
  if (group==="dev") {
    if (!action || !["start","status","logs","restart","stop"].includes(action) || args.length) throw new UsageError("dev requires one of: start, status, logs, restart, stop");
    const found=await project(parsed), id=stringOption(parsed,"id"), rawLines=stringOption(parsed,"lines");
    if(action!=="status"&&id===undefined)throw new UsageError(`--id is required for dev ${action}`);
    const lines=rawLines===undefined?undefined:Number(rawLines); if(lines!==undefined&&(!Number.isInteger(lines)||lines<1||lines>500))throw new UsageError("--lines must be an integer from 1 through 500");
    if(lines!==undefined&&action!=="logs")throw new UsageError("--lines is valid only for dev logs");
    let executor:"host"|"docker"="host";
    if(context.env.MPX_RUNTIME_CONTEXT!==undefined){const selected=context.env.MPX_RUNTIME_EXECUTOR;if(selected!=="host"&&selected!=="docker")throw new MpxError({code:"DEV_EXECUTOR_BINDING_REQUIRED",message:"Launch-bound development services require an exact executor binding and never fall back to host."});executor=selected;}
    const service=context.devService??(executor==="docker"?undefined:defaultDevService(context.env,found.root));
    if(!service||(executor==="docker"&&service.runtimeKind!=="docker"))throw new MpxError({code:"DEV_EXECUTOR_UNSUPPORTED",message:"Docker development services require an injected matching Docker runtime adapter; host fallback is forbidden."});
    if(service.runtimeKind!==undefined&&service.runtimeKind!==executor)throw new MpxError({code:"DEV_EXECUTOR_BINDING_REQUIRED",message:"The development-service adapter does not match the selected executor."});
    data=await executeDevCommand({action,...(id?{id}:{}),cwd:parsed.cwd,config:found.config,projectRoot:found.root,...(action==="start"?{portService:ports(context) as never}:{}),service,executor,...(lines===undefined?{}:{lines})});
    return {data,warnings};
  }
  if (["issue","review","ci"].includes(group)) {
    const actions=group==="issue"
      ? ["list","view","create","edit","comment","label","move","finish"]
      : group==="review"
        ? ["view","create","update","comment","ready","merge"]
        : ["status","watch","logs","retry"];
    if(!action || !actions.includes(action)) throw new UsageError(`${group} requires one of: ${actions.join(", ")}`);
    if(args.length) throw new UsageError(`${group} ${action} accepts only explicit flags`);
    const capability=`${group}.${action}`;
    const role=group==="issue"?"issues":"repository";
    const binding=await providerBinding(parsed,context,role,capability);
    if(group==="review" && action==="ready" && binding.found.config.workflow?.codeReview?.markReady==="human") throw new MpxError({code:"WORKFLOW_POLICY_DENIED",message:"Project workflow policy requires a human to mark reviews ready.",capability});
    if(group==="review" && action==="merge" && binding.found.config.workflow?.codeReview?.merge==="human") throw new MpxError({code:"WORKFLOW_POLICY_DENIED",message:"Project workflow policy requires a human to merge reviews.",capability});
    let input:Record<string,unknown>={};
    if(group==="issue") {
      if(action==="list") { const state=stringOption(parsed,"state"); if(state!==undefined && state!=="open" && state!=="finished") throw new UsageError("--state must be open or finished"); input=state===undefined?{}:{state}; }
      else if(action==="view"||action==="finish") input={id:requiredOption(parsed,"id")};
      else if(action==="create") input={title:requiredOption(parsed,"title"),body:requiredOption(parsed,"body")};
      else if(action==="edit") input={id:requiredOption(parsed,"id"),title:requiredOption(parsed,"title"),body:requiredOption(parsed,"body")};
      else if(action==="comment") input={id:requiredOption(parsed,"id"),body:requiredOption(parsed,"body")};
      else if(action==="label") input={id:requiredOption(parsed,"id"),label:requiredOption(parsed,"label")};
      else if(action==="move") input={id:requiredOption(parsed,"id"),destination:requiredOption(parsed,"destination")};
    } else if(group==="review") {
      if(action==="view"||action==="ready") input={id:requiredOption(parsed,"id")};
      else if(action==="create") input={title:requiredOption(parsed,"title"),body:requiredOption(parsed,"body"),sourceBranch:requiredOption(parsed,"source-branch"),targetBranch:requiredOption(parsed,"target-branch"),draft:binding.found.config.workflow?.codeReview?.openAsDraft??false};
      else if(action==="update") input={id:requiredOption(parsed,"id"),title:requiredOption(parsed,"title"),body:requiredOption(parsed,"body")};
      else if(action==="comment") input={id:requiredOption(parsed,"id"),body:requiredOption(parsed,"body")};
      else if(action==="merge") { const method=stringOption(parsed,"method")??"merge"; if(!["merge","squash","rebase"].includes(method)) throw new UsageError("--method must be merge, squash, or rebase"); input={id:requiredOption(parsed,"id"),method}; }
    } else if(action==="status"||action==="watch") input={id:requiredOption(parsed,"id")};
    else { const id=requiredOption(parsed,"run-id"); input={id,runId:id}; }
    data=await (await providerService(context,binding.found.config,binding.found.root,{providerId:binding.providerId,capability})).invoke({providerId:binding.providerId,capability,route:binding.route,input:asJson(input)});
    return {data,warnings};
  }
  if (group==="launch" && action==="resolve") throw new UsageError("launch resolve was replaced by 'mpx launch explain'");
  if (group==="launch" && action==="current") {
    if(args.length) throw new UsageError("launch current accepts no arguments");
    return {data:currentLaunchTuple(context.env),warnings};
  }
  if (group==="runtime" && (action==="claude" || action==="pi")) {
    if(args.length) throw new UsageError(`runtime ${action} accepts no arguments`);
    const tuple=currentLaunchTuple(context.env), bound=JSON.parse(context.env.MPX_RUNTIME_CONTEXT!) as {runtimeArtifact?:{runtime?:string}};
    if(bound.runtimeArtifact?.runtime!==action) throw new MpxError({code:"RUNTIME_CONTEXT_MISMATCH",message:"The process-bound runtime does not match the requested runtime entry.",remediation:"Relaunch and restart the runtime process."});
    return {data:tuple,warnings};
  }
  if (group==="launch" && (action==="explain" || action==="claude" || action==="pi" || shortLaunchAliases.has(action as ShortLaunchAlias))) {
    if (args.length) throw new UsageError(`launch ${action} accepts no positional arguments`);
    const alias=shortLaunchAliases.has(action as ShortLaunchAlias)?action as ShortLaunchAlias:undefined;
    const user=await requiredUserConfig(context);
    const found=await discoverProjectConfig(parsed.cwd);
    const projectId=found?.config.project.id, repositoryId=projectId??"unbound/runtime";
    const stringOption=(name:string):string|undefined=>{const value=parsed.options.get(name);return typeof value==="string"?value:undefined;};
    const runtimeOption=action==="claude"||action==="pi" ? action : stringOption("runtime");
    if (runtimeOption!==undefined && runtimeOption!=="claude" && runtimeOption!=="pi") throw new MpxError({code:"RUNTIME_INVALID",message:"Runtime must be 'claude' or 'pi'."});
    const identityOption=stringOption("identity"), modeOption=stringOption("mode"), skillPolicyOption=stringOption("skill-policy");
    const contentScopeOption=stringOption("content-scope"), presetOption=stringOption("preset"), reasonOption=stringOption("reason");
    const executorOption=stringOption("executor"), workspaceOption=stringOption("workspace"), networkPolicyOption=stringOption("network-policy");
    if (executorOption!==undefined && executorOption!=="host" && executorOption!=="docker") throw new MpxError({code:"EXECUTOR_UNAVAILABLE",message:`Executor '${executorOption}' is unavailable.`});
    if (workspaceOption!==undefined && workspaceOption!=="clone" && workspaceOption!=="host-worktree" && workspaceOption!=="direct") throw new MpxError({code:"WORKSPACE_INVALID",message:`Workspace strategy '${workspaceOption}' is invalid.`});
    const common=(runtime?:"claude"|"pi",identity?:string):ResolveLaunchSelectionInput=>({
      userConfig:user,cwd:parsed.cwd,...(runtime?{runtime}:{}),...(identity?{identity}:{}),...(alias?{alias}:{}),
      ...(modeOption?{mode:modeOption}:{}), ...(skillPolicyOption?{skillPolicy:skillPolicyOption}:{}),
      ...(contentScopeOption?{contentScope:contentScopeOption}:{}),
      ...(executorOption==="host"||executorOption==="docker"?{executor:executorOption}:{}),
      ...(workspaceOption==="clone"||workspaceOption==="host-worktree"||workspaceOption==="direct"?{workspace:workspaceOption}:{}),
      ...(networkPolicyOption?{networkPolicy:networkPolicyOption}:{}), ...(presetOption?{preset:presetOption}:{}),
      ...(projectId?{projectId}:{}),
    });
    const publicSelection=(selection:Awaited<ReturnType<typeof resolveLaunchSelection>>)=>({
      mode:{name:selection.mode.name},skillPolicy:{name:selection.skillPolicy.name},contentScope:selection.contentScope,
      executor:selection.executor,workspace:selection.workspace,networkPolicy:{name:selection.networkPolicy.name},preset:selection.preset,
      provenance:selection.provenance,cwdClassification:selection.cwdClassification,
    });
    if (action==="explain" && !identityOption) {
      if (modeOption||skillPolicyOption||contentScopeOption||executorOption||workspaceOption||networkPolicyOption||presetOption||parsed.options.has("grant")||reasonOption) throw new MpxError({code:"IDENTITY_REQUIRED",message:"Direct launch overrides require --identity; candidate explanation never infers one."});
      const candidates=[];
      for (const identity of Object.keys(user.identities).sort()) {
        const selection=await resolveLaunchSelection(common(runtimeOption ?? "pi",identity));
        candidates.push({identity,...publicSelection(selection),identityDomainCompatible:selection.identity.domain===selection.cwdClassification.domain});
      }
      return {data:{schemaVersion:1,identity:null,runtime:runtimeOption??null,candidates},warnings};
    }
    if (!identityOption && !alias) throw new MpxError({code:"IDENTITY_REQUIRED",message:"Launch identity must be supplied explicitly."});
    const runtime=runtimeOption ?? (alias?undefined:"pi");
    const launchInput=common(runtime,identityOption);
    const selection=await resolveLaunchSelection(launchInput);
    if (action==="explain" && runtimeOption===undefined) {
      if (projectId && selection.identity.domain!==selection.cwdClassification.domain) throw new MpxError({
        code:"IDENTITY_DOMAIN_MISMATCH",
        message:`Identity '${selection.identity.name}' cannot launch in domain '${selection.cwdClassification.domain}' without an explicit grant.`,
      });
      return {data:{schemaVersion:1,runtime:null,identity:selection.identity,selection:publicSelection(selection)},warnings};
    }
    const sbxProbe=context.sbxDiagnostics??(context===defaultContext?()=>createDefaultSbxDiagnostics(context.env,parsed.cwd):undefined);
    if (action!=="explain" && selection.executor==="docker" && sbxProbe) {
      const sbx=await sbxProbe(), code=sbx.failureCodes[0];
      if (sbx.readOnly!==true) throw new MpxError({code:"SBX_DIAGNOSTICS_UNSAFE",message:"Sandbox diagnostics must be read-only."});
      if (code) throw new MpxError({code,message:`Standalone sbx launch diagnostic: ${code}.`,details:{executor:"docker"}});
    }
    const opts=resolveOptions(user,{identity:selection.identity.name,skillPolicy:selection.skillPolicy.name,contentScope:selection.contentScope.name,repositoryId,...(projectId ? {projectId} : {})});
    const canonicalRoot=await catalogPath(context,parsed.cwd), canonicalCatalog=await inventoryCanonical(canonicalRoot);
    const projectInventory=found ? await inventoryProjectSkills(found.root,canonicalCatalog) : {skills:[],diagnostics:[]};
    if(projectInventory.diagnostics.length) throw new SkillCatalogError(projectInventory.diagnostics);
    const catalog=[...canonicalCatalog,...projectInventory.skills].sort((left,right)=>left.identity.localeCompare(right.identity));
    const manifest=resolveManifest(catalog,opts), artifact=createRuntimeSkillArtifact(manifest,catalog,{runtime:selection.runtime});
    const scope=user.contentScopes[selection.contentScope.name]!, projectOverride=projectId?user.projects?.[projectId]:undefined;
    const skillArtifact=createSkillArtifactReference({runtime:selection.runtime,identity:selection.identity.name,skillPolicy:selection.skillPolicy.name,contentScope:selection.contentScope.name,projectId:projectId??null,catalogHash:sha256Canonical(catalog.map(skill=>({identity:skill.identity,contentHash:skill.contentHash,...("directoryHash" in skill?{origin:"project",directoryHash:skill.directoryHash,realPath:skill.realPath,realProjectRoot:skill.realProjectRoot}:{origin:"canonical"})})) as unknown as JsonValue),enabledPacks:resolveEffectiveSkillPacks({contentScopeSkillPacks:scope.skillPacks,projectSkillPacks:projectOverride?.skillPacks,skillPolicySkillPacks:selection.skillPolicy.declaration.skillPacks}),skillPolicyConfig:selection.skillPolicy.declaration as unknown as JsonValue,contentScopeExposure:(scope.skillExposure??{}) as unknown as JsonValue,projectExposure:(projectOverride?.skillExposure??null) as unknown as JsonValue});
    const evidence=action==="explain"?{status:"unverified" as const,verifier:"launch-explain",evidenceDigest:sha256Canonical({executor:selection.executor,operation:"explain"} as unknown as JsonValue)}:await executorEvidence(context,selection.executor), tty=context.launchTty??directProcessTty();
    let hostApproval:{reason:string;approvalKey:string}|undefined;
    if(selection.executor==="host" && action!=="explain") {
      if(parsed.json || !tty.direct) throw new MpxError({code:"HOST_TTY_REQUIRED",message:"Host approval requires a current direct interactive TTY.",remediation:"Run the explicit host launch interactively, or use Docker."});
      if(!reasonOption?.trim()) throw new MpxError({code:"HOST_REASON_REQUIRED",message:"Host execution requires a nonempty reason."});
      if(!await tty.confirm(`Approve elevated host compatibility execution — ${sanitizeHostReason(reasonOption)}`)) throw new MpxError({code:"HOST_APPROVAL_DENIED",message:"Host execution was not approved."});
      hostApproval={reason:reasonOption,approvalKey:sha256Canonical({cwd:parsed.cwd,runtime:selection.runtime,identity:selection.identity.name,reason:reasonOption} as unknown as JsonValue)};
    }
    const grantOptions=parsed.options.get("grant");
    const descriptor=await resolveLaunch({
      ...launchInput, ...(Array.isArray(grantOptions)?{grants:grantOptions}:{}), ...(reasonOption?{reason:reasonOption}:{}), ...(hostApproval?{hostApproval}:{}),
      skillArtifact,selectedNativeRuntimeRoot:user.identities[selection.identity.name]!.runtimeRoots[selection.runtime],...(projectId ? {projectId} : {}),repositoryId,
      dockerAvailability:evidence.status==="verified"?"available":evidence.status==="unavailable"?"unavailable":"unverified",executorVerification:evidence,
      policyInputs:{schemaVersion:1,manifestKey:manifest.manifestKey,skillArtifactKey:skillArtifact.artifactKey},
    });
    if(action==="explain") return {data:serializeLaunchPublic(descriptor),warnings};
    const appData=context.env.APPDATA;
    if(!appData) throw new MpxError({code:"USER_CONFIG_ROOT_MISSING",message:"APPDATA is required to publish immutable runtime projections."});
    const statusSnapshot = found
      ? async (): Promise<StatusSnapshotV1> => status(context).snapshot({ cwd: parsed.cwd, projectRoot: found.root, config: found.config, configHash: sha256Canonical(found.config as unknown as JsonValue) })
      : async (): Promise<StatusSnapshotV1> => parseStatusSnapshotV1({ schemaVersion: 1, project: { id: repositoryId, cwd: parsed.cwd }, worktree: { id: null, path: null, role: null, branch: null }, portResolution: "missing", services: [], diagnostics: [] });
    const processResult=await executeResolvedLaunch({descriptor,manifest,artifact,catalog,canonicalRoot,agentsRoot:path.join(path.dirname(canonicalRoot),"agents"),artifactsRoot:path.join(appData,"mpx","runtime-artifacts"),stateRoot:context.env.LOCALAPPDATA ? path.join(context.env.LOCALAPPDATA,"mpx") : "",cwd:parsed.cwd,environment:context.env,context,tty,nativeRuntimeRoot:user.identities[selection.identity.name]!.runtimeRoots[selection.runtime],statusSnapshot});
    return {data:null,warnings,silent:true,exitCode:processResult.exitCode};
  }
  if (group === "worktree" && ["create","remove","list","select","status","prepare","cancel","reconcile"].includes(action ?? "")) {
    const service=worktrees(context, parsed.cwd);
    const stringOption=(name:string):string|undefined=>{const value=parsed.options.get(name);return typeof value==="string"?value:undefined};
    if (action==="select" && parsed.options.get("cancel")===true) {
      if(args.length || stringOption("path")) throw new UsageError("worktree select cancellation accepts no path");
      return {data:null,warnings,silent:true};
    }
    const preparationApproval=():string|undefined=>{
      const packageAutomationApproval=stringOption("package-approval"), explicitExecutableApproval=stringOption("explicit-executable-approval");
      if (stringOption("approval")) throw new UsageError("--approval is not valid for preparation; use separate --package-approval and --explicit-executable-approval options");
      return packageAutomationApproval === undefined && explicitExecutableApproval === undefined ? undefined : JSON.stringify({...(packageAutomationApproval===undefined?{}:{packageAutomationApproval}),...(explicitExecutableApproval===undefined?{}:{explicitExecutableApproval})});
    };
    if (action==="create") {
      const template=stringOption("template");
      if(args.length>1 || (args.length===0 && !template)) throw new UsageError("worktree create requires one branch or a complete --template");
      const author=stringOption("author"), issue=stringOption("issue"), slug=stringOption("slug");
      const expanded=template ? expandBranchTemplate(template,{...(author?{author}:{}),...(issue?{issue}:{}),...(slug?{slug}:{})}) : undefined;
      const branch=args[0]??expanded!;
      const execution=stringOption("execution"); if(execution!==undefined && !["foreground","background","none"].includes(execution)) throw new UsageError("--execution must be foreground, background, or none");
      data=await service.create({cwd:parsed.cwd,branch,...(stringOption("base")?{base:stringOption("base")} : {}),...(template?{template} : {}),...(stringOption("slug")?{slug:stringOption("slug")} : {}),...(stringOption("author")?{author:stringOption("author")} : {}),...(stringOption("issue")?{issue:stringOption("issue")} : {}),...(execution?{execution}:{}),...(preparationApproval()?{approval:preparationApproval()} : {}),...(stringOption("include-approval")?{includeApproval:stringOption("include-approval")} : {}),...(stringOption("source")?{sourceRoot:stringOption("source")} : {})});
    } else if(action==="remove") {if(args.length!==1) throw new UsageError("worktree remove requires exactly one path");data=await service.remove({cwd:parsed.cwd,worktreePath:args[0]!});}
    else if(action==="list") {if(args.length) throw new UsageError("worktree list accepts no arguments");data=await service.list({cwd:parsed.cwd});}
    else if(action==="status") {if(args.length) throw new UsageError("worktree status accepts no arguments");data=await service.status({cwd:parsed.cwd});}
    else if(action==="prepare") {if(args.length!==1) throw new UsageError("worktree prepare requires exactly one lifecycle key");data=await service.prepare({cwd:parsed.cwd,key:args[0]!,...(preparationApproval()?{approval:preparationApproval()}:{})});}
    else if(action==="cancel") {if(args.length!==1) throw new UsageError("worktree cancel requires exactly one lifecycle key");data=await service.cancel({cwd:parsed.cwd,key:args[0]!});}
    else if(action==="reconcile") {if(args.length) throw new UsageError("worktree reconcile accepts no arguments");data=await service.reconcile({cwd:parsed.cwd,...(stringOption("orphan-approval")?{orphanApproval:stringOption("orphan-approval")}:{})});}
    else {
      const selectedPath=stringOption("path")??args[0]; if(args.length>(stringOption("path")?0:1) || !selectedPath) throw new UsageError("worktree select requires exactly one explicit path");
      const selected=await service.select({cwd:parsed.cwd,path:selectedPath}); data=selected;
      if(parsed.options.get("machine")===true) return {data,warnings,machinePath:selected.path};
    }
    return {data,warnings};
  }
  if (group === "ports" && ["ensure","resolve","list","inspect","kill","release","reconcile"].includes(action ?? "")) {
    const service = ports(context);
    if (action === "list") {
      if (args.length) throw new UsageError("ports list accepts no arguments");
      data = [...await service.list()].sort((a, b) => a.leaseId.localeCompare(b.leaseId));
    }
    else if (action === "inspect") {
      if (args.length) throw new UsageError("ports inspect accepts no arguments");
      data = await service.inspect();
    }
    else if (action === "kill") {
      const optionPid = parsed.options.get("pid");
      if (args.length > 1 || (optionPid !== undefined && args.length !== 0)) throw new UsageError("ports kill accepts one PID, either positionally or with --pid");
      const raw = optionPid ?? args[0];
      if (typeof raw !== "string" || !/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new UsageError("ports kill requires a positive integer PID");
      const pid = Number(raw); await service.kill(pid); data = { killed: true, pid };
    } else if (action === "release") { if (args.length) throw new UsageError("ports release accepts no arguments"); await service.release({ cwd: parsed.cwd }); data = { released: true }; }
    else if (action === "reconcile") {
      if (args.length) throw new UsageError("ports reconcile accepts no arguments");
      if (parsed.options.get("rebuild") === true) {
        const [user, found] = await Promise.all([userConfig(context), project(parsed)]);
        const roots = [...new Set([...Object.values(user.domains).flat(), found.root].map((root) => path.resolve(root)))];
        data = await service.rebuild({ roots });
      } else data = await service.reconcile({ cwd: parsed.cwd });
    }
    else {
      if (args.length) throw new UsageError(`ports ${action} accepts no arguments`);
      const found = await project(parsed); const request = { cwd: parsed.cwd, projectRoot: found.root, config: found.config, configHash: sha256Canonical(found.config as unknown as JsonValue) };
      if (action === "ensure") { const result = await service.ensure(request); data = result.lease; warnings = result.warnings.map((warning) => ({ code: warning.code, message: warning.message, severity: "warning", ...(warning.port === undefined ? {} : { details: { port: warning.port } }) })); }
      else data = await service.resolve(request);
    }
    return { data, warnings };
  }
  if (group === "status" && !action) {
    const found = await project(parsed);
    data = await status(context, context.portService).snapshot({ cwd: parsed.cwd, projectRoot: found.root, config: found.config, configHash: sha256Canonical(found.config as unknown as JsonValue) });
    return { data, warnings };
  }
  if (group==="init" && !action) {
    const existing=await discoverProjectConfig(parsed.cwd);
    const suggestedManifest:ProjectConfig={schemaVersion:1,project:{id:`REPLACE_ME/${path.basename(parsed.cwd)}`},repository:{provider:"generic",remote:"REPLACE_ME"}};
    const plan=planInit(parsed.cwd,Boolean(existing));
    if (parsed.options.get("confirm") !== true) return {data:{plan,suggestedManifest},warnings};
    const service=ports(context);
    const confirmation=await confirmInit(parsed.cwd,Boolean(existing),suggestedManifest);
    const found=existing ?? await project(parsed);
    const request={cwd:parsed.cwd,projectRoot:found.root,config:found.config,configHash:sha256Canonical(found.config as unknown as JsonValue)};
    let result:Awaited<ReturnType<typeof service.ensure>>;
    try { result=await service.ensure(request); }
    catch(error) {
      let rollbackError:unknown;
      try { await rollbackConfirmedInit(confirmation); } catch(caught) { rollbackError=caught; }
      const code=(value:unknown):string=>value instanceof MpxError ? value.code : "COMMAND_FAILED";
      const portCompensation=error instanceof MpxError && error.code==="PORT_ENSURE_COMPENSATION_FAILED";
      if (portCompensation || rollbackError) {
        const details=error instanceof MpxError && error.details && typeof error.details==="object" && !Array.isArray(error.details)
          ? error.details as Record<string,unknown> : {};
        throw new MpxError({
          code:portCompensation?"INIT_COMPENSATION_FAILED":"INIT_ROLLBACK_FAILED",
          message:portCompensation?"Init port publication failed and exact lease compensation could not be completed.":"Init failed and its owned manifest could not be rolled back safely.",
          remediation:"Inspect the project init artifacts and port registry, then retry init.",
          details:{originalCode:typeof details.originalCode==="string"?details.originalCode:code(error),...(typeof details.compensationCode==="string"?{compensationCode:details.compensationCode}:{}),...(rollbackError?{rollbackCode:code(rollbackError)}:{})},
        });
      }
      throw error;
    }
    warnings=[...(confirmation.pendingTemporaryPath?[{code:"INIT_TEMP_CLEANUP_PENDING",message:"Init completed, but owned temporary-file cleanup is pending.",severity:"warning" as const}]:[]),...result.warnings.map((warning)=>({code:warning.code,message:warning.message,severity:"warning" as const,...(warning.port===undefined?{}:{details:{port:warning.port}})}))];
    data={plan,suggestedManifest,confirmed:true,lease:result.lease}; return {data,warnings};
  }
  if (group==="config" && ["show","resolve","explain","validate"].includes(action??"")) {
    const found=await project(parsed);
    if (action==="show") data = {path:found.path,config:found.config};
    else if (action==="validate") data = {valid:true,path:found.path};
    else { const resolved=await resolveConfig(found.config,await userConfig(context),parsed.cwd); data = action==="explain" ? {provenance:resolved.provenance} : resolved; }
    return { data, warnings };
  }
  if (group==="doctor" && !action) {
    const found=await project(parsed), user=await userConfig(context), resolved=await resolveConfig(found.config,user,parsed.cwd);
    const catalog=await inventoryCanonical(await catalogPath(context,parsed.cwd));
    const local=await inventoryProjectSkills(found.root,catalog);
    const diagnostics: Diagnostic[] = [
      ...configDoctor(found.config,user).map(({ code, message, severity, pointer }) => ({ code, message, severity, ...(pointer ? { details: { pointer } } : {}) })),
      ...skillDoctor(catalog,local).map(({ code, message, path: diagnosticPath }) => ({ code, message, severity: "error" as const, ...(diagnosticPath ? { details: { path: diagnosticPath } } : {}) })),
    ];
    const sbxProbe=context.sbxDiagnostics??(context===defaultContext?()=>createDefaultSbxDiagnostics(context.env,parsed.cwd):undefined);
    if (sbxProbe) {
      const sbx = await sbxProbe();
      if (sbx.readOnly !== true) throw new MpxError({code:"SBX_DIAGNOSTICS_UNSAFE",message:"Sandbox diagnostics must be read-only."});
      for (const code of [...new Set(sbx.failureCodes)].sort()) diagnostics.push({ code, message: `Standalone sbx diagnostic: ${code}.`, severity: "warning", details: { executor: "docker" } });
    }
    const services = Object.entries(found.config.development?.services ?? {}).sort(([left], [right]) => left.localeCompare(right));
    for (const [name, service] of services) if (service.port.mode === "fixed-shared") diagnostics.push({ code: "FIXED_SHARED_LIMITATION", message: `Service ${name} uses a fixed-shared port that MPX cannot reserve exclusively.`, severity: "warning", details: { service: name, ...(service.port.preferred === undefined ? {} : { port: service.port.preferred }) } });
    if (services.some(([, service]) => service.port.mode === "managed")) {
      const request = { cwd: parsed.cwd, projectRoot: found.root, config: found.config, configHash: sha256Canonical(found.config as unknown as JsonValue) };
      const snapshot = await status(context, ports(context)).snapshot(request);
      diagnostics.push(...snapshot.diagnostics.map(({ code, message, severity, serviceId }) => ({ code, message, severity, ...(serviceId ? { details: { service: serviceId } } : {}) })));
    }
    data = {diagnostics, cwdClassification:resolved.cwdClassification, resolvedContentScope:resolved.contentScope.name}; return { data, warnings, exitCode: diagnostics.some(({ severity }) => severity === "error") ? 1 : 0 };
  }
  if (group==="provider" && ["list","explain","doctor"].includes(action??"")) {
    if (action==="list") {
      const role=parsed.options.get("role");
      if (role !== undefined && role !== "repository" && role !== "issues") throw new UsageError("--role must be repository or issues");
      data = configuredProviderRegistry(context).list(role); return { data, warnings };
    }
    if(action==="doctor") {
      if(args.length) throw new UsageError("provider doctor accepts no arguments");
      const identityName=stringOption(parsed,"identity");
      if(identityName===undefined) throw new MpxError({code:"IDENTITY_REQUIRED",message:"Provider doctor requires an explicit identity."});
      const [found,user]=await Promise.all([project(parsed),requiredUserConfig(context)]), identity=user.identities[identityName];
      if(!identity) throw new MpxError({code:"IDENTITY_UNKNOWN",message:`Unknown identity '${identityName}'.`});
      const selections:["issues"|"repository",string][]=[["issues",found.config.issues?.provider??"none"],["repository",found.config.repository.provider]];
      const executor=context.providerProcessExecutor??new NodeProviderProcessExecutor(context.env);
      const providers=await Promise.all(selections.map(async([role,provider])=>{
        const descriptor=configuredProviderRegistry(context).get(provider,role), route=identity.providerRoutes?.[provider];
        if(descriptor.capabilities.length>0 && !route) throw new MpxError({code:"PROVIDER_ROUTE_REQUIRED",message:`Identity '${identityName}' has no route for provider '${provider}'.`,remediation:"Configure identity.providerRoutes for the selected provider."});
        const probe=await probeProvider({providerId:provider,role,...(route===undefined?{}:{route}),cwd:found.root},executor);
        return {role,provider,backend:descriptor.backend,capabilities:descriptor.capabilities.filter(capability=>role==="issues"?capability.startsWith("issue."):!capability.startsWith("issue.")),route:route??null,...probe};
      }));
      data={schemaVersion:1,identity:identityName,providers}; return {data,warnings,exitCode:providers.some(provider=>provider.status==="error")?1:0};
    }
    const role = args[0];
    if (role !== "repository" && role !== "issues") throw new UsageError("provider explain requires repository or issues");
    const found = await project(parsed);
    const providerId = role === "repository" ? found.config.repository.provider : found.config.issues?.provider ?? "none";
    const descriptor = configuredProviderRegistry(context).get(providerId, role);
    data = {
      role,
      provider: descriptor.id,
      adapter: descriptor.backend,
      capabilities: descriptor.capabilities.filter((capability) =>
        role === "issues" ? capability.startsWith("issue.") : !capability.startsWith("issue."),
      ),
      route: null,
      routeSelection: "identity-required",
    }; return { data, warnings };
  }
  if (group==="skill" && ["list","search","show","explain","complete"].includes(action??"")) {
    const identityOption=parsed.options.get("identity");
    if (typeof identityOption !== "string") throw new MpxError({code:"IDENTITY_REQUIRED",message:"Skill resolution requires an explicit launch identity."});
    const user=await requiredUserConfig(context);
    if (!user.identities[identityOption]) throw new MpxError({code:"IDENTITY_UNKNOWN",message:`Unknown identity '${identityOption}'.`});
    const runtimeOption=parsed.options.get("runtime");
    if (runtimeOption === undefined) throw new MpxError({code:"SKILL_RUNTIME_REQUIRED",message:"Skill resolution requires an explicit runtime."});
    if (runtimeOption !== "claude" && runtimeOption !== "pi") throw new MpxError({code:"SKILL_RUNTIME_INVALID",message:"Skill runtime must be 'claude' or 'pi'."});
    const skillPolicyOption=parsed.options.get("skill-policy");
    if (typeof skillPolicyOption !== "string") throw new MpxError({code:"SKILL_POLICY_REQUIRED",message:"Skill resolution requires an explicit skill policy."});
    if (!user.skillPolicies[skillPolicyOption]) throw new MpxError({code:"SKILL_POLICY_UNKNOWN",message:`Unknown skill policy '${skillPolicyOption}'.`});
    const canonicalCatalog=await inventoryCanonical(await catalogPath(context,parsed.cwd));
    const found=await discoverProjectConfig(parsed.cwd);
    const projectInventory=found ? await inventoryProjectSkills(found.root,canonicalCatalog) : {skills:[],diagnostics:[]};
    if(projectInventory.diagnostics.length) throw new SkillCatalogError(projectInventory.diagnostics);
    const catalog=[...canonicalCatalog,...projectInventory.skills].sort((left,right)=>left.identity.localeCompare(right.identity));
    const cwdClassification=await knownCwdClassification(parsed.cwd,user);
    const contentScopeOption=parsed.options.get("content-scope");
    const projectId=found?.config.project.id, contentScope=typeof contentScopeOption==="string"?contentScopeOption:cwdClassification.contentScope;
    const opts=resolveOptions(user,{identity:identityOption,skillPolicy:skillPolicyOption,contentScope,repositoryId:projectId??"unbound/runtime",...(projectId ? {projectId} : {})});
    const manifest=resolveManifest(catalog,opts), runtimeArtifact=createRuntimeSkillArtifact(manifest,catalog,{runtime:runtimeOption});
    const artifact={...runtimeArtifact.reference,identity:identityOption,skillPolicy:skillPolicyOption,contentScope,projectId:projectId??null};
    if (action==="list") {
      if (args.length) throw new UsageError("skill list accepts no arguments");
      const exposure=new Map(runtimeArtifact.entries.map((entry)=>[entry.identity,entry.exposure]));
      data={artifact,manifest:{schemaVersion:manifest.schemaVersion,manifestKey:manifest.manifestKey,binding:manifest.binding},skills:humanListSkills(runtimeArtifact).map((skill)=>({...skill,exposure:exposure.get(skill.identity)}))};
      return { data, warnings };
    }
    const identity=args[0]; if (!identity) throw new UsageError(`skill ${action} requires ${action==="search"?"a query":action==="complete"?"a prefix":"an id"}`);
    if (action==="complete") return {data:{artifact,completions:humanCompleteSkills(runtimeArtifact,args.join(" "))},warnings};
    const skill=catalog.find((item:{identity:string})=>item.identity===identity);
    const entry=runtimeArtifact.entries.find((item)=>item.identity===identity);
    if (action==="show") { const detail=humanSkillDetail(runtimeArtifact,catalog,identity); if(!detail || !skill || !entry) throw new MpxError({code:"SKILL_NOT_FOUND",message:`Skill '${identity}' was not found in the launch-bound artifact.`}); return { data:{artifact,skill:{...detail,skillPacks:"skillPacks" in skill?skill.skillPacks:[],exposure:entry.exposure}}, warnings }; }
    if (action==="explain") { if(!skill) throw new MpxError({code:"SKILL_NOT_FOUND",message:`Skill '${identity}' was not found.`}); return { data:{artifact,skill:explainSkill(skill,opts)}, warnings }; }
    const limit=Number(parsed.options.get("limit")??20);
    if (!Number.isInteger(limit)) throw new UsageError("--limit must be an integer");
    const requestedArtifact=parsed.options.get("artifact-key");
    data = typeof requestedArtifact==="string"
      ? searchSkills(runtimeArtifact,catalog,args.join(" "),{limit,runtime:true,artifactKey:requestedArtifact})
      : humanSearchSkills(runtimeArtifact,catalog,args.join(" "),{limit});
    return { data:{artifact,results:data}, warnings };
  }
  throw new UsageError(usage);
}

export async function run(argv:string[]=process.argv.slice(2), io:CliIo=processIo, context:CliContext=defaultContext):Promise<number> {
  let parsed:Parsed|undefined;
  try { parsed=parse(argv); const result=await execute(parsed,context); if(result.machinePath!==undefined) io.stdout(`${result.machinePath}\n`); else if(!result.silent) { if (parsed.json) io.stdout(JSON.stringify(successEnvelope(asJson(result.data), result.warnings))+"\n"); else { io.stdout(human(result.data)); for (const warning of result.warnings) io.stderr(`${warning.code}: ${warning.message}\n`); } } return result.exitCode ?? 0; }
  catch(error) {
    const usageError=error instanceof UsageError;
    const skillDiagnostic=error instanceof SkillCatalogError ? error.diagnostics[0] : undefined;
    const normalized = usageError
      ? new MpxError({ code: "USAGE_ERROR", message: error.message })
      : error instanceof MpxError
        ? error
        : error instanceof ExecutionError
          ? executionMpxError(error)
        : skillDiagnostic
          ? new MpxError({ code: skillDiagnostic.code, message: sanitizePublicMessage(skillDiagnostic.message) })
          : error instanceof StrictJsonError
            ? invalidConfigError()
          : error instanceof ConfigValidationError
            ? normalizeConfigError(error)
            : new MpxError({ code: "COMMAND_FAILED", message: "Command failed." });
    if (parsed?.json || argv.includes("--json")) io.stdout(JSON.stringify(errorEnvelope(normalized))+"\n");
    else io.stderr(`${normalized.code}: ${normalized.message}\n${usageError?usage+"\n":""}`);
    return usageError?2:1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "__preparation-worker" && process.argv.length === 4) {
    try { await executeInternalPreparationWorker(process.argv[3]!, process.env.MPX_PREPARATION_WORKER_TOKEN); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  } else process.exitCode=await run();
}
