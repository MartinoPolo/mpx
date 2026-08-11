import { join } from "node:path";
export interface InitPlan { schemaVersion:1; cwd:string; actions:ReadonlyArray<{type:"create"|"skip";path:string;reason:string}> }
export function planInit(cwd:string,hasManifest:boolean):InitPlan {const root=join(cwd,"mpxconfig.json");const type: "create"|"skip"=hasManifest?"skip":"create";return Object.freeze({schemaVersion:1,cwd,actions:Object.freeze([{type,path:root,reason:hasManifest?"manifest-exists":"manifest-missing"}])})}
