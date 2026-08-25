import path from "node:path";
import type { DevServiceManager, ExecutorKind, PortAssignment } from "./index.js";
export interface DevServerToolInput {readonly action:"start"|"status"|"logs"|"restart"|"stop";readonly id?:string;readonly executable?:string;readonly args?:readonly string[];readonly cwd?:string;readonly ports?:readonly number[];readonly lines?:number}
export interface DevServerToolBinding {readonly launchKey:string;readonly executor:ExecutorKind;readonly cwd:string;readonly assignment:PortAssignment}
export interface DevServerToolAdapter {readonly name:"dev_server";readonly launchKey:string;readonly description:string;execute(input:DevServerToolInput):Promise<unknown>}
function required(value:string|undefined,name:string):string {if(!value?.trim())throw new Error(`${name} is required for this action.`);return value.trim()}
export function createDevServerToolAdapter(manager:DevServiceManager,binding:DevServerToolBinding):DevServerToolAdapter {
  if(!/^[a-f0-9]{64}$/u.test(binding.launchKey))throw new Error("A valid immutable launch key is required for the dev_server adapter.");
  return Object.freeze({name:"dev_server" as const,launchKey:binding.launchKey,description:"Start, inspect, restart, and stop a launch-owned foreground development service. Readiness requires every assigned port.",async execute(input:DevServerToolInput){
    if(input.action==="status")return input.id===undefined?manager.list():manager.status(input.id);
    const id=required(input.id,"id");
    if(input.action==="logs"){const lines=input.lines??200;if(!Number.isInteger(lines)||lines<1||lines>500)throw new Error("lines must be an integer from 1 through 500.");return manager.logs(id,{maxLines:lines,maxCharacters:20000})}
    if(input.action==="restart")return manager.restart(id);
    if(input.action==="stop")return manager.stop(id);
    if(input.action!=="start")throw new Error("Unsupported dev_server action.");
    return manager.start({id,executable:required(input.executable,"executable"),args:input.args??[],cwd:path.resolve(input.cwd??binding.cwd),ports:input.ports??[],assignment:binding.assignment,executor:binding.executor});
  }});
}
