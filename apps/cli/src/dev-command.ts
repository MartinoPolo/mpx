import path from "node:path";
import { sha256Canonical, type JsonValue } from "@mpx/core";
import type { ProjectConfig } from "@mpx/config";
import { DurableDevServiceManager, createSystemRuntime, type DevServiceSnapshot, type ExecutorKind, type StartRequest } from "@mpx/dev-services";

export interface CliDevService {
  readonly runtimeKind?:ExecutorKind;
  start(request:StartRequest):Promise<DevServiceSnapshot|unknown>;
  status(id?:string):DevServiceSnapshot|readonly DevServiceSnapshot[]|unknown|Promise<DevServiceSnapshot|readonly DevServiceSnapshot[]|unknown>;
  logs(id:string,options?:{maxLines?:number;maxCharacters?:number}):string|Promise<string>;
  restart(id:string):Promise<DevServiceSnapshot|unknown>;
  stop(id:string):Promise<DevServiceSnapshot|unknown>;
}
export interface DevPortResolver { resolve(request:{cwd:string;projectRoot:string;config:ProjectConfig;configHash:string}):Promise<{services:Record<string,number>;ownerRoot?:string}|{lease:{services:Record<string,number>;ownerRoot?:string}}> }
export function defaultDevService(environment:NodeJS.ProcessEnv,projectRoot:string):CliDevService {
  const local=environment.LOCALAPPDATA;
  if(!local||!path.isAbsolute(local))throw new Error("LOCALAPPDATA is required for durable development-service state.");
  const scope=sha256Canonical({projectRoot:path.resolve(projectRoot).replaceAll("\\","/").toLowerCase()} as JsonValue);
  const manager=new DurableDevServiceManager(createSystemRuntime(),path.join(local,"mpx","dev-services",scope));
  return Object.assign(manager,{runtimeKind:"host" as const});
}
const safeScript=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export function packageInvocation(config:ProjectConfig,script:string):{executable:string;args:string[]} {
  if(!safeScript.test(script))throw new Error("Package script must be a bounded safe label.");
  const manager=config.tooling?.packageManager??"auto";
  if(manager==="none")throw new Error("A package manager is required for package-script development services.");
  const executable=manager==="auto"?"npm":manager;
  return {executable,args:["run",script]};
}
export async function executeDevCommand(input:{action:string;id?:string;cwd:string;config:ProjectConfig;projectRoot:string;portService?:DevPortResolver;service:CliDevService;executor:"host"|"docker";lines?:number}):Promise<unknown>{
  if(input.action==="status")return input.service.status(input.id);
  if(!input.id)throw new Error(`--id is required for dev ${input.action}`);
  if(input.action==="logs")return input.service.logs(input.id,{maxLines:input.lines??200,maxCharacters:20000});
  if(input.action==="restart")return input.service.restart(input.id);
  if(input.action==="stop")return input.service.stop(input.id);
  if(input.action!=="start")throw new Error("dev requires one of: start, status, logs, restart, stop");
  const configured=input.config.development?.services[input.id];if(!configured)throw new Error(`Unknown configured development service '${input.id}'.`);
  if(configured.start.type==="package-script")packageInvocation(input.config,configured.start.script); // Validate repository-controlled input before any state or process operation.
  if(!input.portService)throw new Error("Development service start requires the port state service.");
  const resolved=await input.portService.resolve({cwd:input.cwd,projectRoot:input.projectRoot,config:input.config,configHash:sha256Canonical(input.config as unknown as JsonValue)});const services="lease" in resolved?resolved.lease.services:resolved.services;const port=services[input.id];if(port===undefined)throw new Error(`No assigned worktree port exists for service '${input.id}'.`);
  const environment:Record<string,string>={};
  for(const [serviceId,definition] of Object.entries(input.config.development?.services??{})){
    if(!definition.environmentVariable)continue;
    const assigned=services[serviceId];if(assigned===undefined)throw new Error(`No assigned worktree port exists for coupled service '${serviceId}'.`);
    if(environment[definition.environmentVariable]!==undefined)throw new Error(`Development service environment variable '${definition.environmentVariable}' is declared more than once.`);
    environment[definition.environmentVariable]=`${definition.protocol??"http"}://localhost:${assigned}`;
  }
  if(configured.start.type!=="package-script")return Object.freeze({id:input.id,state:configured.start.type,managed:false,port,environment:Object.freeze(environment)});
  const invocation=packageInvocation(input.config,configured.start.script);
  const resolvedOwner="lease" in resolved?resolved.lease.ownerRoot:resolved.ownerRoot;
  if(configured.scope==="project"&&!resolvedOwner)throw new Error("Project-scoped development services require the canonical main-worktree owner root.");
  const cwd=path.resolve(configured.scope==="project"?resolvedOwner!:input.projectRoot);
  return input.service.start({id:input.id,...invocation,cwd,ports:[port],assignment:{worktreeRoot:cwd,ports:[port]},executor:input.executor,environment});
}
