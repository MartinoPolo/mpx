#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProjectConfig, doctor as configDoctor, loadUserConfig, planInit, resolveConfig, type DiscoveredConfig, type UserConfig } from "@mpx/config";
import { errorEnvelope, MpxError, successEnvelope, type JsonValue } from "@mpx/core";
import { providerRegistry } from "@mpx/providers";
import { explainSkill, inventoryCanonical, inventoryProjectSkills, resolveManifest, searchSkills, doctor as skillDoctor, type ResolveOptions } from "@mpx/skills";
import { catalogPath, defaultContext, type CliContext } from "./context.js";
import { processIo, type CliIo } from "./io.js";

interface Parsed { command: string[]; cwd: string; json: boolean; options: Map<string,string|boolean> }
class UsageError extends Error {}
const usage = "Usage: mpx [--cwd DIR] [--json] <init|config|doctor|provider|skill>";

function parse(argv: readonly string[]): Parsed {
  const words: string[] = [], options = new Map<string,string|boolean>();
  for (let i=0;i<argv.length;i++) {
    const word=argv[i]!;
    if (!word.startsWith("--")) { words.push(word); continue; }
    const [name,inline]=word.slice(2).split("=",2);
    if (["json","runtime"].includes(name!)) options.set(name!,true);
    else if (["cwd","role","limit","artifact-key"].includes(name!)) {
      const value=inline ?? argv[++i]; if (!value || value.startsWith("--")) throw new UsageError(`--${name} requires a value`); options.set(name!,value);
    } else throw new UsageError(`Unknown option: --${name}`);
  }
  return { command:words, cwd:path.resolve(String(options.get("cwd")??process.cwd())), json:options.get("json")===true, options };
}
async function present(file:string):Promise<boolean>{try{await access(file);return true}catch{return false}}
async function userConfig(context:CliContext):Promise<UserConfig>{
  const appdata=context.env.APPDATA;
  if (!appdata) return {scopes:{}};
  const file=path.join(appdata,"mpx","config.json");
  return await present(file) ? loadUserConfig(file,context.env) : {scopes:{}};
}
async function project(parsed:Parsed):Promise<DiscoveredConfig>{
  const found=await discoverProjectConfig(parsed.cwd);
  if (!found) throw new MpxError({code:"CONFIG_NOT_FOUND",message:"No mpxconfig.json was found.",remediation:"Run 'mpx init' in the project root."});
  return found;
}
function resolveOptions(resolved:Awaited<ReturnType<typeof resolveConfig>>):ResolveOptions {
  return {
    runtime: "pi",
    scope: resolved.scope.name,
    projectId: resolved.project.project.id,
    enabledPacks: resolved.scope.skillPacks,
    scopeExposure: resolved.scope.skillExposure,
    ...(resolved.scope.projectSkillExposure
      ? { projectExposure: resolved.scope.projectSkillExposure }
      : {}),
    mappingVersion: "1",
  };
}
function human(value:unknown):string {
  if (Array.isArray(value)) return value.map(item=>typeof item==="string"?item:JSON.stringify(item)).join("\n")+"\n";
  if (typeof value==="string") return value+"\n";
  return JSON.stringify(value,null,2)+"\n";
}
function asJson(value:unknown):JsonValue { return value as JsonValue }

async function execute(parsed:Parsed, context:CliContext):Promise<unknown> {
  const [group,action,...args]=parsed.command;
  if (!group) throw new UsageError(usage);
  if (group==="init" && !action) {
    const existing=await discoverProjectConfig(parsed.cwd);
    return {plan:planInit(parsed.cwd,Boolean(existing)),suggestedManifest:{schemaVersion:1,project:{id:path.basename(parsed.cwd)},repository:{provider:"generic",remote:"REPLACE_ME"}}};
  }
  if (group==="config" && ["show","resolve","explain","validate"].includes(action??"")) {
    const found=await project(parsed);
    if (action==="show") return {path:found.path,config:found.config};
    if (action==="validate") return {valid:true,path:found.path};
    const resolved=await resolveConfig(found.config,await userConfig(context),found.root);
    return action==="explain" ? {provenance:resolved.provenance} : resolved;
  }
  if (group==="doctor" && !action) {
    const found=await project(parsed), user=await userConfig(context), resolved=await resolveConfig(found.config,user,found.root);
    const catalog=await inventoryCanonical(await catalogPath(context,parsed.cwd));
    const local=await inventoryProjectSkills(found.root,catalog);
    return {diagnostics:[...configDoctor(found.config,user),...skillDoctor(catalog,local)],resolvedScope:resolved.scope.name};
  }
  if (group==="provider" && ["list","explain"].includes(action??"")) {
    if (action==="list") {
      const role=parsed.options.get("role");
      if (role !== undefined && role !== "repository" && role !== "issues") throw new UsageError("--role must be repository or issues");
      return providerRegistry.list(role);
    }
    const role = args[0];
    if (role !== "repository" && role !== "issues") throw new UsageError("provider explain requires repository or issues");
    const found = await project(parsed);
    const resolved = await resolveConfig(found.config, await userConfig(context), found.root);
    const providerId = role === "repository" ? found.config.repository.provider : found.config.issues?.provider ?? "none";
    const descriptor = providerRegistry.get(providerId, role);
    return {
      role,
      provider: descriptor.id,
      adapter: descriptor.backend,
      capabilities: descriptor.capabilities.filter((capability) =>
        role === "issues" ? capability.startsWith("issue.") : !capability.startsWith("issue."),
      ),
      connection: resolved.scope.connections[descriptor.id] ?? null,
    };
  }
  if (group==="skill" && ["list","search","show","explain"].includes(action??"")) {
    const catalog=await inventoryCanonical(await catalogPath(context,parsed.cwd));
    if (action==="list") return catalog.map(({identity,description,skillPacks,defaultExposure}:{identity:string;description:string;skillPacks:string[];defaultExposure:string})=>({identity,description,skillPacks,defaultExposure}));
    const identity=args[0]; if (!identity) throw new UsageError(`skill ${action} requires ${action==="search"?"a query":"an id"}`);
    const skill=catalog.find((item:{identity:string})=>item.identity===identity);
    if (action==="show") { if(!skill) throw new MpxError({code:"SKILL_NOT_FOUND",message:`Skill '${identity}' was not found.`}); return skill; }
    const found=await project(parsed), resolved=await resolveConfig(found.config,await userConfig(context),found.root), opts=resolveOptions(resolved);
    if (action==="explain") { if(!skill) throw new MpxError({code:"SKILL_NOT_FOUND",message:`Skill '${identity}' was not found.`}); return explainSkill(skill,opts); }
    const manifest=resolveManifest(catalog,opts); const limit=Number(parsed.options.get("limit")??20);
    if (!Number.isInteger(limit)) throw new UsageError("--limit must be an integer");
    const artifact=parsed.options.get("artifact-key");
    return searchSkills(manifest,catalog,args.join(" "),{limit,...(parsed.options.get("runtime")===true?{runtime:true}:{}),...(typeof artifact==="string"?{artifactKey:artifact}:{})});
  }
  throw new UsageError(usage);
}

export async function run(argv:string[]=process.argv.slice(2), io:CliIo=processIo, context:CliContext=defaultContext):Promise<number> {
  let parsed:Parsed|undefined;
  try { parsed=parse(argv); const data=await execute(parsed,context); io.stdout(parsed.json?JSON.stringify(successEnvelope(asJson(data)))+"\n":human(data)); return 0; }
  catch(error) {
    const usageError=error instanceof UsageError;
    const configError = (error as { name?: string }).name === "ConfigValidationError";
    const normalized = usageError
      ? new MpxError({ code: "USAGE_ERROR", message: error.message })
      : error instanceof MpxError
        ? error
        : new MpxError({
            code: configError ? "CONFIG_INVALID" : "COMMAND_FAILED",
            message: configError ? "Configuration is invalid." : "Command failed.",
          });
    if (parsed?.json || argv.includes("--json")) io.stdout(JSON.stringify(errorEnvelope(normalized))+"\n");
    else io.stderr(`${normalized.code}: ${normalized.message}\n${usageError?usage+"\n":""}`);
    return usageError?2:1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))) process.exitCode=await run();
