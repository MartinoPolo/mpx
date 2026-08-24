import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig } from "./types.js";

export interface InitPlan { schemaVersion:1; cwd:string; actions:ReadonlyArray<{type:"create"|"skip";path:string;reason:string}> }
export interface ConfirmedInit { plan: InitPlan; manifestPath: string }

export function planInit(cwd:string,hasManifest:boolean):InitPlan {
  const root=join(cwd,"mpxconfig.json");
  const type: "create"|"skip"=hasManifest?"skip":"create";
  return Object.freeze({schemaVersion:1,cwd,actions:Object.freeze([{type,path:root,reason:hasManifest?"manifest-exists":"manifest-missing"}])});
}

/** Apply exactly the manifest action represented by planInit; existing manifests are never rewritten. */
export async function confirmInit(cwd:string,hasManifest:boolean,suggestedManifest:ProjectConfig):Promise<ConfirmedInit> {
  const plan=planInit(cwd,hasManifest);
  const manifestPath=plan.actions[0]!.path;
  if (!hasManifest) await writeFile(manifestPath,`${JSON.stringify(suggestedManifest,null,2)}\n`,{encoding:"utf8",flag:"wx"});
  return {plan,manifestPath};
}
