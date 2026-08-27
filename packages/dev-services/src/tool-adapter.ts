import type { DevServiceManager, StartRequest } from "./index.js";

export interface DevServerToolInput {
  readonly action:"start"|"status"|"logs"|"restart"|"stop";
  readonly id?:string;
  readonly lines?:number;
}
export interface DevServerToolBinding {
  readonly launchKey:string;
  /** Fully resolved, repository-declared services admitted for this exact launch. */
  readonly services:Readonly<Record<string,StartRequest>>;
}
export interface DevServerToolAdapter {readonly name:"dev_server";readonly launchKey:string;readonly description:string;execute(input:DevServerToolInput):Promise<unknown>}
function required(value:string|undefined,name:string):string {if(!value?.trim())throw new Error(`${name} is required for this action.`);return value.trim()}
function exactInput(input:DevServerToolInput):void {
  const allowed=input.action==="logs"?new Set(["action","id","lines"]):new Set(["action","id"]);
  if(Object.keys(input as object).some(key=>!allowed.has(key)))throw new Error("model-supplied executable, argv, root, ports, launch, or executor authority is forbidden.");
}
export function createDevServerToolAdapter(manager:DevServiceManager,binding:DevServerToolBinding):DevServerToolAdapter {
  if(!/^[a-f0-9]{64}$/u.test(binding.launchKey))throw new Error("A valid immutable launch key is required for the dev_server adapter.");
  return Object.freeze({name:"dev_server" as const,launchKey:binding.launchKey,description:"Start, inspect, restart, and stop configured launch-bound development services. Commands, roots, ports, environment, and executor are repository/runtime assigned and cannot be supplied by the model.",async execute(input:DevServerToolInput){
    exactInput(input);
    if(input.action==="status")return input.id===undefined?manager.list():manager.status(input.id);
    const id=required(input.id,"id");
    if(input.action==="logs"){const lines=input.lines??200;if(!Number.isInteger(lines)||lines<1||lines>500)throw new Error("lines must be an integer from 1 through 500.");return manager.logs(id,{maxLines:lines,maxCharacters:20000})}
    if(input.action==="restart")return manager.restart(id);
    if(input.action==="stop")return manager.stop(id);
    if(input.action!=="start")throw new Error("Unsupported dev_server action.");
    const service=binding.services[id];
    if(!service)throw new Error(`Service '${id}' is undeclared for this launch.`);
    return manager.start(service);
  }});
}
