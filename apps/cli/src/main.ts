#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProjectConfig, doctor as configDoctor, loadUserConfig, planInit, resolveConfig, type DiscoveredConfig, type UserConfig } from "@mpx/config";
import { errorEnvelope, MpxError, sha256Canonical, successEnvelope, type Diagnostic, type JsonValue } from "@mpx/core";
import { providerRegistry } from "@mpx/providers";
import { explainSkill, inventoryCanonical, inventoryProjectSkills, resolveManifest, searchSkills, doctor as skillDoctor, type ResolveOptions } from "@mpx/skills";
import { catalogPath, defaultContext, ports, status, type CliContext } from "./context.js";
import { processIo, type CliIo } from "./io.js";

interface Parsed { command: string[]; cwd: string; json: boolean; options: Map<string,string|boolean> }
interface ExecuteResult { data: unknown; warnings: Diagnostic[]; exitCode?: number }
class UsageError extends Error {}
const usage = "Usage: mpx [--cwd DIR] [--json] <init|config|doctor|provider|skill|status|ports ensure|resolve|list|inspect|kill|release|reconcile>";

function parse(argv: readonly string[]): Parsed {
  const words: string[] = [], options = new Map<string,string|boolean>();
  for (let i=0;i<argv.length;i++) {
    const word=argv[i]!;
    if (!word.startsWith("--")) { words.push(word); continue; }
    const [name,inline]=word.slice(2).split("=",2);
    if (["json","runtime","rebuild"].includes(name!)) options.set(name!,true);
    else if (["cwd","role","limit","artifact-key","pid"].includes(name!)) {
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

async function execute(parsed:Parsed, context:CliContext):Promise<ExecuteResult> {
  const [group,action,...args]=parsed.command;
  if (!group) throw new UsageError(usage);
  if (parsed.options.get("rebuild") === true && (group !== "ports" || action !== "reconcile")) throw new UsageError("--rebuild is valid only for ports reconcile");
  let data: unknown;
  let warnings: Diagnostic[] = [];
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
        const roots = [...new Set([...Object.values(user.scopes).flatMap((scope) => scope.roots), found.root].map((root) => path.resolve(root)))];
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
    data = {plan:planInit(parsed.cwd,Boolean(existing)),suggestedManifest:{schemaVersion:1,project:{id:path.basename(parsed.cwd)},repository:{provider:"generic",remote:"REPLACE_ME"}}}; return { data, warnings };
  }
  if (group==="config" && ["show","resolve","explain","validate"].includes(action??"")) {
    const found=await project(parsed);
    if (action==="show") data = {path:found.path,config:found.config};
    else if (action==="validate") data = {valid:true,path:found.path};
    else { const resolved=await resolveConfig(found.config,await userConfig(context),found.root); data = action==="explain" ? {provenance:resolved.provenance} : resolved; }
    return { data, warnings };
  }
  if (group==="doctor" && !action) {
    const found=await project(parsed), user=await userConfig(context), resolved=await resolveConfig(found.config,user,found.root);
    const catalog=await inventoryCanonical(await catalogPath(context,parsed.cwd));
    const local=await inventoryProjectSkills(found.root,catalog);
    const diagnostics: Diagnostic[] = [
      ...configDoctor(found.config,user).map(({ code, message, severity, pointer }) => ({ code, message, severity, ...(pointer ? { details: { pointer } } : {}) })),
      ...skillDoctor(catalog,local).map(({ code, message, path: diagnosticPath }) => ({ code, message, severity: "error" as const, ...(diagnosticPath ? { details: { path: diagnosticPath } } : {}) })),
    ];
    const services = Object.entries(found.config.development?.services ?? {}).sort(([left], [right]) => left.localeCompare(right));
    for (const [name, service] of services) if (service.port.mode === "fixed-shared") diagnostics.push({ code: "FIXED_SHARED_LIMITATION", message: `Service ${name} uses a fixed-shared port that MPX cannot reserve exclusively.`, severity: "warning", details: { service: name, ...(service.port.preferred === undefined ? {} : { port: service.port.preferred }) } });
    if (services.some(([, service]) => service.port.mode === "managed")) {
      const request = { cwd: parsed.cwd, projectRoot: found.root, config: found.config, configHash: sha256Canonical(found.config as unknown as JsonValue) };
      const snapshot = await status(context, ports(context)).snapshot(request);
      diagnostics.push(...snapshot.diagnostics.map(({ code, message, severity, serviceId }) => ({ code, message, severity, ...(serviceId ? { details: { service: serviceId } } : {}) })));
    }
    data = {diagnostics, resolvedScope:resolved.scope.name}; return { data, warnings, exitCode: diagnostics.some(({ severity }) => severity === "error") ? 1 : 0 };
  }
  if (group==="provider" && ["list","explain"].includes(action??"")) {
    if (action==="list") {
      const role=parsed.options.get("role");
      if (role !== undefined && role !== "repository" && role !== "issues") throw new UsageError("--role must be repository or issues");
      data = providerRegistry.list(role); return { data, warnings };
    }
    const role = args[0];
    if (role !== "repository" && role !== "issues") throw new UsageError("provider explain requires repository or issues");
    const found = await project(parsed);
    const resolved = await resolveConfig(found.config, await userConfig(context), found.root);
    const providerId = role === "repository" ? found.config.repository.provider : found.config.issues?.provider ?? "none";
    const descriptor = providerRegistry.get(providerId, role);
    data = {
      role,
      provider: descriptor.id,
      adapter: descriptor.backend,
      capabilities: descriptor.capabilities.filter((capability) =>
        role === "issues" ? capability.startsWith("issue.") : !capability.startsWith("issue."),
      ),
      connection: resolved.scope.connections[descriptor.id] ?? null,
    }; return { data, warnings };
  }
  if (group==="skill" && ["list","search","show","explain"].includes(action??"")) {
    const catalog=await inventoryCanonical(await catalogPath(context,parsed.cwd));
    if (action==="list") { data = catalog.map(({identity,description,skillPacks,defaultExposure}:{identity:string;description:string;skillPacks:string[];defaultExposure:string})=>({identity,description,skillPacks,defaultExposure})); return { data, warnings }; }
    const identity=args[0]; if (!identity) throw new UsageError(`skill ${action} requires ${action==="search"?"a query":"an id"}`);
    const skill=catalog.find((item:{identity:string})=>item.identity===identity);
    if (action==="show") { if(!skill) throw new MpxError({code:"SKILL_NOT_FOUND",message:`Skill '${identity}' was not found.`}); return { data: skill, warnings }; }
    const found=await project(parsed), resolved=await resolveConfig(found.config,await userConfig(context),found.root), opts=resolveOptions(resolved);
    if (action==="explain") { if(!skill) throw new MpxError({code:"SKILL_NOT_FOUND",message:`Skill '${identity}' was not found.`}); return { data: explainSkill(skill,opts), warnings }; }
    const manifest=resolveManifest(catalog,opts); const limit=Number(parsed.options.get("limit")??20);
    if (!Number.isInteger(limit)) throw new UsageError("--limit must be an integer");
    const artifact=parsed.options.get("artifact-key");
    data = searchSkills(manifest,catalog,args.join(" "),{limit,...(parsed.options.get("runtime")===true?{runtime:true}:{}),...(typeof artifact==="string"?{artifactKey:artifact}:{})}); return { data, warnings };
  }
  throw new UsageError(usage);
}

export async function run(argv:string[]=process.argv.slice(2), io:CliIo=processIo, context:CliContext=defaultContext):Promise<number> {
  let parsed:Parsed|undefined;
  try { parsed=parse(argv); const result=await execute(parsed,context); if (parsed.json) io.stdout(JSON.stringify(successEnvelope(asJson(result.data), result.warnings))+"\n"); else { io.stdout(human(result.data)); for (const warning of result.warnings) io.stderr(`${warning.code}: ${warning.message}\n`); } return result.exitCode ?? 0; }
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
