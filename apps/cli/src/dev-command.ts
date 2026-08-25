import path from "node:path";
import { sha256Canonical, type JsonValue } from "@mpx/core";
import type { ProjectConfig } from "@mpx/config";
import { DevServiceManager, createSystemRuntime, type DevServiceSnapshot, type StartRequest } from "@mpx/dev-services";

export interface CliDevService {
  start(request:StartRequest):Promise<DevServiceSnapshot|unknown>;
  status(id?:string):DevServiceSnapshot|readonly DevServiceSnapshot[]|unknown;
  logs(id:string,options?:{maxLines?:number;maxCharacters?:number}):string;
  restart(id:string):Promise<DevServiceSnapshot|unknown>;
  stop(id:string):Promise<DevServiceSnapshot|unknown>;
}
export interface DevPortResolver { resolve(request:{cwd:string;projectRoot:string;config:ProjectConfig;configHash:string}):Promise<{services:Record<string,number>}|{lease:{services:Record<string,number>}}> }
let productionManager:DevServiceManager|undefined;
export function defaultDevService():CliDevService {
  if(productionManager)return productionManager;
  productionManager=new DevServiceManager(createSystemRuntime());
  const cleanup=()=>{void productionManager?.shutdown().finally(()=>{process.exitCode=process.exitCode??0})};
  process.once("SIGINT",cleanup);process.once("SIGTERM",cleanup);
  return productionManager;
}
function packageCommand(config:ProjectConfig,script:string):string {const manager=config.tooling?.packageManager??"auto";if(manager==="none")throw new Error("A package manager is required for package-script development services.");const executable=manager==="auto"?"npm":manager;return executable==="npm"?`npm run ${script}`:`${executable} run ${script}`}
export async function executeDevCommand(input:{action:string;id?:string;cwd:string;config:ProjectConfig;projectRoot:string;portService:DevPortResolver;service:CliDevService;executor:"host"|"docker";lines?:number}):Promise<unknown>{
  if(input.action==="status")return input.service.status(input.id);
  if(!input.id)throw new Error(`--id is required for dev ${input.action}`);
  if(input.action==="logs")return input.service.logs(input.id,{maxLines:input.lines??200,maxCharacters:20000});
  if(input.action==="restart")return input.service.restart(input.id);
  if(input.action==="stop")return input.service.stop(input.id);
  if(input.action!=="start")throw new Error("dev requires one of: start, status, logs, restart, stop");
  const configured=input.config.development?.services[input.id];if(!configured)throw new Error(`Unknown configured development service '${input.id}'.`);
  const resolved=await input.portService.resolve({cwd:input.cwd,projectRoot:input.projectRoot,config:input.config,configHash:sha256Canonical(input.config as unknown as JsonValue)});const services="lease" in resolved?resolved.lease.services:resolved.services;const port=services[input.id];if(port===undefined)throw new Error(`No assigned worktree port exists for service '${input.id}'.`);
  const cwd=configured.scope==="checkout"?input.projectRoot:input.projectRoot;
  return input.service.start({id:input.id,command:packageCommand(input.config,configured.start.script),cwd:path.resolve(cwd),ports:[port],assignment:{worktreeRoot:path.resolve(input.projectRoot),ports:[port]},executor:input.executor});
}
