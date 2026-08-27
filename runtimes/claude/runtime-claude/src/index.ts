import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { enumerateSkillDirectory, loadSkillBody, verifyRuntimeSkillArtifact, type CatalogSkill, type ResolvedManifest, type RuntimeSkillArtifact } from "@mpx/skills";
import { parseResolvedSkillManifestV4, parseRuntimeContextV1, publishRuntimeArtifact, validateRuntimeContext, validateSessionLifecycleBindingV1, RuntimeContractError, type NativeSessionRefV1, type PublishedRuntimeArtifactReference, type RuntimeContextV1, type RuntimeContractDiagnostic } from "@mpx/runtime-contracts";
import { classifyDangerousCommand, dangerousCommandPolicyModuleSource, evaluatePackagePolicy, type PackageManager } from "@mpx/runtime-hooks";
import { parseStatusSnapshotV1, renderClaudePortSegment, type StatusSnapshotV1 } from "@mpx/status";

export class ClaudeRuntimeError extends Error { constructor(readonly code:string,message:string){super(`${code}: ${message}`);this.name="ClaudeRuntimeError";} }
export interface ClaudeBuildInput { readonly manifest:ResolvedManifest; readonly artifact:RuntimeSkillArtifact; readonly catalog:readonly CatalogSkill[]; readonly canonical:string; readonly agents:string; readonly outputRoot:string; readonly statusSnapshot:StatusSnapshotV1; readonly launchBanner:string; readonly runtimeContext:RuntimeContextV1 }
export interface ClaudeProjection { readonly directory:string; readonly artifactKey:string; readonly files:readonly string[] }
export interface ClaudePublishedProjection extends ClaudeProjection { readonly pluginDirectory:string; readonly reference:PublishedRuntimeArtifactReference; readonly reused:boolean }
export interface ClaudePublishInput extends Omit<ClaudeBuildInput,"outputRoot"> { readonly artifactsRoot:string; readonly artifactRevalidator?:Parameters<typeof publishRuntimeArtifact>[0]["revalidate"] }
const q=(value:string)=>JSON.stringify(value);
function skillText(entry:RuntimeSkillArtifact["entries"][number],skill:CatalogSkill,body:string):string {
 const description=entry.exposure==="full"?skill.description:`mpx skill ${entry.identity}`;
 const lines=["---",`name: ${entry.identity}`,`description: ${q(description)}`];
 const triggers="triggers" in skill?skill.triggers:undefined;
 if(entry.exposure==="full"&&triggers)lines.push(`triggers: ${q(triggers)}`);
 lines.push("user-invocable: true",...(entry.exposure==="explicit-only"?["disable-model-invocation: true"]:[]),"---",body);
 return `${lines.join("\n")}${body.endsWith("\n")?"":"\n"}`;
}
async function write(root:string,relative:string,text:string|Uint8Array,files:string[]):Promise<void>{const target=path.join(root,...relative.split("/"));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,text);files.push(relative);}
function pluginJson(){return `${JSON.stringify({name:"mpx",version:"0.0.0",description:"MPX Claude runtime projection"},null,2)}\n`;}
function statusSnapshotFile(snapshot: unknown): string { return `${JSON.stringify(parseStatusSnapshotV1(snapshot), null, 2)}\n`; }
const hookCommand='node "${CLAUDE_PLUGIN_ROOT}/hooks/runtime-guard.mjs"';
const hooksJson=`${JSON.stringify({hooks:{SessionStart:[{hooks:[{type:"command",command:hookCommand,timeout:5}]}],UserPromptSubmit:[{hooks:[{type:"command",command:hookCommand,timeout:5}]}],PreToolUse:[{matcher:"Skill|Agent|Task|Bash",hooks:[{type:"command",command:hookCommand,timeout:5}]}],PostToolUse:[{hooks:[{type:"command",command:hookCommand,timeout:5}]}],Notification:[{hooks:[{type:"command",command:hookCommand,timeout:5}]}],SessionEnd:[{hooks:[{type:"command",command:hookCommand,timeout:5}]}]}},null,2)}\n`;
function runtimeGuard():string{return String.raw`import {createHash,randomUUID} from "node:crypto";
import {lstat,open,opendir,realpath,rename,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const METADATA=".mpx-runtime-artifact.json",MAX_HOOK_INPUT_BYTES=1024*1024,MAX_METADATA_BYTES=4*1024*1024,MAX_CONTEXT_BYTES=1024*1024,MAX_FILE_BYTES=16*1024*1024,MAX_AGGREGATE_BYTES=256*1024*1024,MAX_FILES=10000,MAX_DIRECTORIES=1024,MAX_DEPTH=32,SHA256=/^[a-f0-9]{64}$/u;
const restart=code=>{const error=new Error("RESTART_REQUIRED: "+code);error.code=code;error.mpx=true;throw error};
const stable=value=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":value&&typeof value==="object"?"{"+Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>JSON.stringify(key)+":"+stable(item)).join(",")+"}":JSON.stringify(value);
const record=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const exactKeys=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
const nonempty=value=>typeof value==="string"&&value.length>0&&value.length<=4096;
const digest=value=>typeof value==="string"&&SHA256.test(value);
const within=(candidate,parent)=>{const relative=path.relative(parent,candidate);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative))};
const sameIdentity=(left,right)=>left.dev===right.dev&&left.ino===right.ino;
async function exactRead(file,maximumBytes,code,expectedBytes){
 let handle;
 try{
  handle=await open(file,"r");
  const initial=await handle.stat(),linked=await lstat(file);
  if(!initial.isFile()||linked.isSymbolicLink()||!linked.isFile()||!sameIdentity(initial,linked)||initial.size>maximumBytes||expectedBytes!==undefined&&initial.size!==expectedBytes)restart(code);
  const content=Buffer.alloc(initial.size);let offset=0;
  while(offset<content.length){const result=await handle.read(content,offset,content.length-offset,offset);if(result.bytesRead===0)restart(code);offset+=result.bytesRead}
  if((await handle.read(Buffer.alloc(1),0,1,initial.size)).bytesRead!==0)restart(code);
  const final=await handle.stat(),finalLinked=await lstat(file);
  if(!sameIdentity(initial,final)||!sameIdentity(final,finalLinked)||final.size!==initial.size||final.mtimeMs!==initial.mtimeMs||finalLinked.isSymbolicLink())restart(code);
  return content;
 }catch(error){if(error?.mpx)throw error;restart(code)}finally{await handle?.close().catch(()=>{})}
}
function parseReference(value){
 if(!exactKeys(value,["projectionKey","launchBinding","fileMapHash"])||!digest(value.projectionKey)||!digest(value.fileMapHash))restart("ARTIFACT_BINDING_CHANGED");
 const binding=value.launchBinding;
 if(!exactKeys(binding,["launchKey","descriptorDigest","runtimeArtifactKey","runtime","manifestKey"])||!nonempty(binding.launchKey)||!nonempty(binding.descriptorDigest)||!nonempty(binding.runtimeArtifactKey)||binding.runtime!=="claude"||!nonempty(binding.manifestKey))restart("ARTIFACT_BINDING_CHANGED");
 return value;
}
function safePortablePath(value){
 if(typeof value!=="string"||value.length===0||value.length>1024||value!==value.normalize("NFC")||value.includes("\\")||path.posix.isAbsolute(value))return false;
 const reserved=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
 return value.split("/").every(segment=>segment&&segment!=="."&&segment!==".."&&!reserved.test(segment)&&!/[\u0000-\u001f<>:"|?*]/u.test(segment)&&!/[ .]$/u.test(segment));
}
function parseMetadata(value){
 if(!exactKeys(value,["schemaVersion","reference","fileMap"])||value.schemaVersion!==1||!Array.isArray(value.fileMap)||value.fileMap.length>MAX_FILES)restart("ARTIFACT_BINDING_CHANGED");
 const reference=parseReference(value.reference),files=new Map(),directories=new Map(),portableEntries=new Set();let aggregateBytes=0,previous="";
 for(const item of value.fileMap){
  if(!exactKeys(item,["path","sha256","bytes"])||!safePortablePath(item.path)||item.path===METADATA||!digest(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>MAX_FILE_BYTES)restart("ARTIFACT_BINDING_CHANGED");
  const identity=item.path.toLowerCase();
  if(portableEntries.has(identity)||previous&&previous>=item.path)restart("ARTIFACT_BINDING_CHANGED");
  portableEntries.add(identity);previous=item.path;aggregateBytes+=item.bytes;if(aggregateBytes>MAX_AGGREGATE_BYTES)restart("ARTIFACT_BINDING_CHANGED");
  const segments=item.path.split("/");if(segments.length-1>MAX_DEPTH)restart("ARTIFACT_BINDING_CHANGED");
  for(let depth=1;depth<segments.length;depth+=1){const directory=segments.slice(0,depth).join("/"),directoryIdentity=directory.toLowerCase(),known=directories.get(directoryIdentity);if(known&&known!==directory||files.has(directoryIdentity))restart("ARTIFACT_BINDING_CHANGED");directories.set(directoryIdentity,directory)}
  if(directories.has(identity))restart("ARTIFACT_BINDING_CHANGED");files.set(identity,item);
 }
 if(directories.size>MAX_DIRECTORIES)restart("ARTIFACT_BINDING_CHANGED");
 return {reference,fileMap:value.fileMap,files,directories:new Set(directories.values()),aggregateBytes};
}
async function verifyTree(parsed){
 const rootStat=await lstat(root).catch(()=>restart("ARTIFACT_FILE_MAP_CHANGED"));if(rootStat.isSymbolicLink()||!rootStat.isDirectory())restart("ARTIFACT_SYMLINK");
 const realRoot=await realpath(root).catch(()=>restart("ARTIFACT_FILE_MAP_CHANGED")),seenPortable=new Set(),seenFiles=new Set(),seenDirectories=new Set();let directoryCount=0,aggregateBytes=0;
 async function visit(directory,depth){
  let entries;try{entries=await opendir(directory)}catch{restart("ARTIFACT_FILE_MAP_CHANGED")}
  try{for await(const entry of entries){
   const absolute=path.join(directory,entry.name),relative=path.relative(root,absolute).split(path.sep).join("/"),identity=relative.toLowerCase();
   if(!safePortablePath(relative)||seenPortable.has(identity))restart("ARTIFACT_FILE_MAP_CHANGED");seenPortable.add(identity);
   if(relative===METADATA){if(depth!==0)restart("ARTIFACT_FILE_MAP_CHANGED");const metadataStat=await lstat(absolute).catch(()=>restart("ARTIFACT_FILE_MAP_CHANGED"));if(metadataStat.isSymbolicLink()||!metadataStat.isFile())restart("ARTIFACT_FILE_MAP_CHANGED");continue}
   const expectedFile=parsed.files.get(identity),expectedDirectory=parsed.directories.has(relative);
   if(!expectedFile&&!expectedDirectory)restart("ARTIFACT_FILE_MAP_CHANGED");
   if(expectedFile&&expectedFile.path!==relative)restart("ARTIFACT_FILE_MAP_CHANGED");
   const stat=await lstat(absolute).catch(()=>restart("ARTIFACT_FILE_MAP_CHANGED"));if(stat.isSymbolicLink())restart("ARTIFACT_SYMLINK");
   const resolved=await realpath(absolute).catch(()=>restart("ARTIFACT_FILE_MAP_CHANGED"));if(!within(resolved,realRoot))restart("ARTIFACT_ESCAPE");
   if(expectedDirectory){
    if(!stat.isDirectory()||expectedFile)restart("ARTIFACT_FILE_MAP_CHANGED");directoryCount+=1;if(directoryCount>MAX_DIRECTORIES||depth+1>MAX_DEPTH)restart("ARTIFACT_FILE_MAP_CHANGED");seenDirectories.add(relative);await visit(absolute,depth+1);
   }else{
    if(!stat.isFile()||seenFiles.size>=MAX_FILES)restart("ARTIFACT_FILE_MAP_CHANGED");
    const content=await exactRead(absolute,MAX_FILE_BYTES,"ARTIFACT_FILE_MAP_CHANGED",expectedFile.bytes);aggregateBytes+=content.length;if(aggregateBytes>MAX_AGGREGATE_BYTES||createHash("sha256").update(content).digest("hex")!==expectedFile.sha256)restart("ARTIFACT_FILE_MAP_CHANGED");seenFiles.add(relative);
   }
  }}catch(error){if(error?.mpx)throw error;restart("ARTIFACT_FILE_MAP_CHANGED")}
 }
 await visit(root,0);
 if(seenFiles.size!==parsed.files.size||seenDirectories.size!==parsed.directories.size||aggregateBytes!==parsed.aggregateBytes)restart("ARTIFACT_FILE_MAP_CHANGED");
}
async function validateBinding(){
 let expected,metadata,context,environmentContext;
 try{
  const expectedText=process.env.MPX_RUNTIME_PROJECTION_REFERENCE??"null",contextText=process.env.MPX_RUNTIME_CONTEXT??"null";if(expectedText.length>MAX_CONTEXT_BYTES||contextText.length>MAX_CONTEXT_BYTES)restart("ARTIFACT_BINDING_CHANGED");
  expected=parseReference(JSON.parse(expectedText));metadata=parseMetadata(JSON.parse((await exactRead(path.join(root,METADATA),MAX_METADATA_BYTES,"ARTIFACT_BINDING_CHANGED")).toString("utf8")));
  context=JSON.parse((await exactRead(path.join(root,"runtime-context.json"),MAX_CONTEXT_BYTES,"RUNTIME_CONTEXT_CHANGED")).toString("utf8"));environmentContext=JSON.parse(contextText);
 }catch(error){if(error?.mpx)throw error;restart("ARTIFACT_BINDING_CHANGED")}
 if(stable(metadata.reference)!==stable(expected))restart("ARTIFACT_BINDING_CHANGED");
 const fileMapHash=createHash("sha256").update(stable(metadata.fileMap)).digest("hex"),projectionKey=createHash("sha256").update(stable({schemaVersion:1,launchBinding:expected.launchBinding,fileMapHash})).digest("hex");
 if(fileMapHash!==expected.fileMapHash||projectionKey!==expected.projectionKey)restart("ARTIFACT_FILE_MAP_CHANGED");
 if(stable(context)!==stable(environmentContext)||context?.launchKey!==expected.launchBinding.launchKey||context?.launchDescriptor?.digest!==expected.launchBinding.descriptorDigest||context?.manifestKey!==expected.launchBinding.manifestKey||context?.runtimeArtifact?.artifactKey!==expected.launchBinding.runtimeArtifactKey||context?.runtimeArtifact?.runtime!==expected.launchBinding.runtime)restart("RUNTIME_CONTEXT_CHANGED");
 return metadata;
}
async function validateExpected(metadata,relative){const expected=metadata.files.get(relative.toLowerCase());if(!expected||expected.path!==relative)restart("ARTIFACT_FILE_MAP_CHANGED");const content=await exactRead(path.join(root,...relative.split("/")),MAX_FILE_BYTES,"ARTIFACT_FILE_MAP_CHANGED",expected.bytes);if(createHash("sha256").update(content).digest("hex")!==expected.sha256)restart("ARTIFACT_FILE_MAP_CHANGED");}
const lifecycleControl=/[\u0000-\u001f\u007f-\u009f]/u,lifecycleId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;const lifecycleText=(value,max)=>typeof value==="string"&&value.length>0&&value.length<=max&&!lifecycleControl.test(value)?value:null;
async function emitLifecycle(input,type,required){const directory=process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR,bindingId=process.env.MPX_SESSION_LIFECYCLE_BINDING_ID;if(directory===undefined&&bindingId===undefined)return;if(!directory||!path.isAbsolute(directory)||!lifecycleId.test(bindingId??""))restart("LIFECYCLE_METADATA_INVALID");if(!lifecycleId.test(input.session_id??"")||!lifecycleText(input.cwd,4096)){if(required)restart("LIFECYCLE_METADATA_INVALID");return}const stat=await lstat(directory).catch(()=>restart("LIFECYCLE_EVENT_DIRECTORY_INVALID"));if(stat.isSymbolicLink()||!stat.isDirectory())restart("LIFECYCLE_EVENT_DIRECTORY_INVALID");const resolved=await realpath(directory).catch(()=>restart("LIFECYCLE_EVENT_DIRECTORY_INVALID"));if(path.resolve(resolved)!==path.resolve(directory))restart("LIFECYCLE_EVENT_DIRECTORY_INVALID");const eventId=randomUUID(),timestamp=new Date().toISOString(),sequence=Number(process.hrtime.bigint()/1000n),runtimePid=Number.isSafeInteger(process.ppid)&&process.ppid>0?process.ppid:process.pid,event={schemaVersion:1,eventId,bindingId,type,sequence,timestamp,nativeSessionId:input.session_id,nativeSessionRef:{kind:"native-id",value:input.session_id},cwd:input.cwd,title:lifecycleText(input.title??input.session_name,512),model:lifecycleText(input.model,128),effort:lifecycleText(input.effort,128),pid:runtimePid,startFingerprint:String(runtimePid)+":"+bindingId};const name=String(sequence).padStart(16,"0")+"-"+eventId+".json",target=path.join(directory,name),temporary=target+".tmp-"+process.pid;try{await writeFile(temporary,JSON.stringify(event)+"\n",{flag:"wx"});await rename(temporary,target)}catch{restart("LIFECYCLE_EVENT_WRITE_FAILED")}}
export async function validate(){const metadata=await validateBinding();await verifyTree(metadata);}
async function readHookInput(){return new Promise((resolve,reject)=>{const chunks=[];let bytes=0,settled=false;const cleanup=()=>{process.stdin.off("data",onData);process.stdin.off("end",onEnd);process.stdin.off("error",onError)};const fail=()=>{if(settled)return;settled=true;cleanup();process.stdin.pause();process.stdin.destroy();reject(Error("HOOK_INPUT_INVALID"))};const onData=chunk=>{if(settled)return;const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);if(buffer.length>MAX_HOOK_INPUT_BYTES-bytes){fail();return}bytes+=buffer.length;chunks.push(buffer)};const onEnd=()=>{if(settled)return;settled=true;cleanup();try{resolve(bytes===0?{}:JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,bytes))))}catch{reject(Error("HOOK_INPUT_INVALID"))}};const onError=()=>fail();process.stdin.on("data",onData);process.stdin.on("end",onEnd);process.stdin.on("error",onError)})}
async function main(){let input;try{input=await readHookInput()}catch{restart("HOOK_INPUT_INVALID")}const metadata=await validateBinding(),event=input.hook_event_name,tool=input.tool_name;if(event==="SessionStart"){await verifyTree(metadata);await emitLifecycle(input,"start",true)}else if(event==="Notification")await emitLifecycle(input,"info",false);else if(event==="PostToolUse")await emitLifecycle(input,"activity",false);else if(event==="SessionEnd")await emitLifecycle(input,"shutdown",true);else if(event==="PreToolUse"&&tool==="Skill"){const identity=input.tool_input?.skill??input.tool_input?.name;if(typeof identity!=="string"||!/^[a-z0-9][a-z0-9-]*$/u.test(identity))restart("SKILL_BODY_INVALID");const prefix="skills/"+identity+"/";let matched=0;for(const item of metadata.fileMap)if(item.path.startsWith(prefix)){matched+=1;await validateExpected(metadata,item.path)}if(!matched)restart("SKILL_BODY_INVALID");}else if(event==="PreToolUse"&&(tool==="Agent"||tool==="Task")){const identity=input.tool_input?.subagent_type??input.tool_input?.agent;if(typeof identity==="string"&&/^[a-z0-9][a-z0-9-]*$/u.test(identity))await validateExpected(metadata,"agents/"+identity+".md");else for(const item of metadata.fileMap)if(item.path.startsWith("agents/")&&!item.path.startsWith("agents/references/"))await validateExpected(metadata,item.path);}else if(event==="PreToolUse"&&tool==="Bash"){await validateExpected(metadata,"hooks/dangerous-command-policy.mjs");const {classifyDangerousCommand}=await import("./dangerous-command-policy.mjs");const decision=classifyDangerousCommand(input.tool_input?.command);if(decision.action==="block")console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:decision.code+": "+decision.message}}))}}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(JSON.stringify({schemaVersion:1,code:error.code??"RUNTIME_ARTIFACT_TAMPERED",restartRequired:true,message:error.message})+"\n");process.exitCode=2});
`;}
const statusParser=`const control=/[\\0-\\x1F\\x7F-\\x9F]/u,id=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,safe=(x,n)=>typeof x==="string"&&x.length<=n&&!control.test(x),keys=(x,k)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).sort().join()===k.slice().sort().join();function parse(x){if(!keys(x,["schemaVersion","project","worktree","portResolution","services","diagnostics"])||x.schemaVersion!==1||!keys(x.project,["id","cwd"])||!safe(x.project.id,256)||!safe(x.project.cwd,4096)||!keys(x.worktree,["id","path","role","branch"])||!(x.worktree.id===null||safe(x.worktree.id,256))||!(x.worktree.path===null||safe(x.worktree.path,4096))||!(x.worktree.branch===null||safe(x.worktree.branch,512))||![null,"main","linked"].includes(x.worktree.role)||!["valid","missing","invalid","stale"].includes(x.portResolution)||!Array.isArray(x.services)||x.services.length>256||!Array.isArray(x.diagnostics)||x.diagnostics.length>256)throw Error("STATUS_SNAPSHOT_INVALID");const ids=new Set;for(const s of x.services){if(!keys(s,["id","mode","scope","protocol","port","listening","conflict","pid"])||!id.test(s.id)||ids.has(s.id)||!["managed","fixed-shared"].includes(s.mode)||!["checkout","project"].includes(s.scope)||!["http","https","tcp"].includes(s.protocol)||!(s.port===null||Number.isInteger(s.port)&&s.port>=1&&s.port<=65535)||typeof s.listening!=="boolean"||!["none","external","unknown"].includes(s.conflict)||!(s.pid===null||Number.isSafeInteger(s.pid)&&s.pid>=1))throw Error("STATUS_SNAPSHOT_INVALID");ids.add(s.id)}for(const d of x.diagnostics)if(!keys(d,["code","severity","message","serviceId"])||!id.test(d.code)||!["info","warning","error"].includes(d.severity)||!safe(d.message,1024)||!(d.serviceId===null||id.test(d.serviceId)))throw Error("STATUS_SNAPSHOT_INVALID");return x}`;
function statusScript(launchBanner: string): string {
 return `import {lstat,open} from "node:fs/promises";import path from "node:path";import {fileURLToPath} from "node:url";${statusParser}function ports(x){if(x.portResolution!=="valid")return "ports "+x.portResolution;if(!x.services.length)return "ports none";return "ports "+[...x.services].sort((a,b)=>a.id.localeCompare(b.id)).map(s=>s.id+":"+(s.port??"?")+(s.conflict==="external"?"!":s.conflict==="unknown"?"?":s.listening?"*":"")).join(" ")}const MAX_STATUS_SNAPSHOT_BYTES=1024*1024,sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;async function exactRead(file){let handle;try{handle=await open(file,"r");const initial=await handle.stat(),named=await lstat(file);if(!initial.isFile()||!named.isFile()||named.isSymbolicLink()||!sameIdentity(initial,named)||initial.size!==named.size||initial.size>MAX_STATUS_SNAPSHOT_BYTES)throw Error("STATUS_SNAPSHOT_INVALID");const content=Buffer.alloc(initial.size);let offset=0;while(offset<content.length){const result=await handle.read(content,offset,content.length-offset,offset);if(result.bytesRead===0)throw Error("STATUS_SNAPSHOT_INVALID");offset+=result.bytesRead}if((await handle.read(Buffer.alloc(1),0,1,initial.size)).bytesRead!==0)throw Error("STATUS_SNAPSHOT_INVALID");const final=await handle.stat(),finalNamed=await lstat(file);if(!final.isFile()||!finalNamed.isFile()||finalNamed.isSymbolicLink()||!sameIdentity(initial,final)||!sameIdentity(final,finalNamed)||final.size!==initial.size||finalNamed.size!==initial.size)throw Error("STATUS_SNAPSHOT_INVALID");return content}finally{await handle?.close().catch(()=>{})}}const file=process.env.MPX_STATUS_SNAPSHOT_FILE??path.join(path.dirname(fileURLToPath(import.meta.url)),"status-snapshot.json");let segment="ports invalid";try{segment=ports(parse(JSON.parse((await exactRead(file)).toString("utf8"))))}catch{}process.stdout.write(${q(launchBanner)}+" | "+segment);\n`;
}
function stable(value:unknown):string{if(Array.isArray(value))return`[${value.map(stable).join(",")}]`;if(value&&typeof value==="object")return`{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;return JSON.stringify(value);}
async function verifiedDirectory(root:string,code:string,message:string):Promise<string>{const stat=await lstat(root).catch(()=>undefined);if(!stat?.isDirectory()||stat.isSymbolicLink())throw new ClaudeRuntimeError(code,message);return realpath(root);}
function contained(root:string,candidate:string):boolean{const relative=path.relative(root,candidate);return relative===""||(!relative.startsWith(`..${path.sep}`)&&relative!==".."&&!path.isAbsolute(relative));}
async function canonicalAgents(root:string):Promise<Array<[string,string]>>{const verifiedRoot=await verifiedDirectory(root,"AGENT_ROOT_INVALID","canonical agents root must be a real non-symlink directory");const result:Array<[string,string]>=[];for(const entry of (await readdir(verifiedRoot,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(!entry.isFile()||!/^mpx-[a-z0-9-]+\.md$/.test(entry.name))continue;const file=path.join(verifiedRoot,entry.name),stat=await lstat(file);if(stat.isSymbolicLink())throw new ClaudeRuntimeError("AGENT_SYMLINK","canonical agent may not be a symlink");const resolved=await realpath(file);if(!contained(verifiedRoot,resolved))throw new ClaudeRuntimeError("AGENT_ESCAPE","canonical agent escapes its verified root");const text=await readFile(file,"utf8");if(!text.startsWith("---\n")||!text.includes(`\nname: ${entry.name.slice(0,-3)}\n`))throw new ClaudeRuntimeError("AGENT_INVALID",`invalid canonical agent ${entry.name}`);result.push([entry.name,text.replace("---\n", "---\nmodel: inherit\n")]);}const references=path.join(verifiedRoot,"references");if(await lstat(references).catch(()=>undefined)){const verifiedReferences=await verifiedDirectory(references,"AGENT_REFERENCE_INVALID","agent references root must be a real non-symlink directory");for(const entry of (await readdir(verifiedReferences,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(verifiedReferences,entry.name),stat=await lstat(file);if(!entry.isFile()||stat.isSymbolicLink())throw new ClaudeRuntimeError("AGENT_REFERENCE_INVALID","agent references must be regular files");const resolved=await realpath(file);if(!contained(verifiedReferences,resolved))throw new ClaudeRuntimeError("AGENT_REFERENCE_INVALID","agent references must remain within the verified references root");result.push([`references/${entry.name}`,await readFile(file,"utf8")]);}}return result;}
export async function buildClaudePlugin(input:ClaudeBuildInput):Promise<ClaudeProjection>{
 const manifest=parseResolvedSkillManifestV4(input.manifest);try{verifyRuntimeSkillArtifact(input.artifact,manifest,input.catalog,{runtime:"claude"});}catch(error){if(error instanceof RuntimeContractError&&error.details?.reason==="file-map-binding")throw new ClaudeRuntimeError("STALE_ARTIFACT","runtime operation requires the current exact v4 artifact");throw error;}
 if(input.artifact.runtime!=="claude"||input.artifact.manifestKey!==manifest.manifestKey)throw new ClaudeRuntimeError("ARTIFACT_BINDING_MISMATCH","Claude projection requires its exact v4 Claude artifact");
 if(await lstat(input.outputRoot).catch(()=>undefined))throw new ClaudeRuntimeError("OUTPUT_EXISTS","immutable projection destination already exists");
 const catalog=new Map(input.catalog.map(x=>[x.identity,x]));const projected:Array<[string,string|Uint8Array]>=[];
 for(const entry of input.artifact.entries){const skill=catalog.get(entry.identity);if(!skill)throw new ClaudeRuntimeError("STALE_CATALOG",`missing ${entry.identity}`);const invocation=entry.permissions.modelInvocation?"model":"human-explicit";const loaded=await loadSkillBody({canonicalRoot:input.canonical,manifest:input.manifest,artifact:input.artifact,runtime:"claude",identity:entry.identity,invocation});projected.push([`skills/${entry.identity}/SKILL.md`,skillText(entry,skill,loaded.body)]);for(const support of await enumerateSkillDirectory(path.dirname(skill.sourcePath)))if(support.relativePath!=="SKILL.md")projected.push([`skills/${entry.identity}/${support.relativePath}`,support.bytes]);}
 const agents=await canonicalAgents(input.agents);const runtimeContext=parseRuntimeContextV1(input.runtimeContext);const files:string[]=[];await mkdir(input.outputRoot,{recursive:false});try{
  await write(input.outputRoot,".claude-plugin/plugin.json",pluginJson(),files);
  for(const [relative,text] of projected)await write(input.outputRoot,relative,text,files);
  for(const [name,text] of agents)await write(input.outputRoot,`agents/${name}`,text,files);
  await write(input.outputRoot,"hooks/hooks.json",hooksJson,files);await write(input.outputRoot,"hooks/dangerous-command-policy.mjs",`${dangerousCommandPolicyModuleSource}\n`,files);await write(input.outputRoot,"hooks/runtime-guard.mjs",runtimeGuard(),files);await write(input.outputRoot,"status/status-snapshot.json",statusSnapshotFile(input.statusSnapshot),files);await write(input.outputRoot,"status/status-line.mjs",statusScript(input.launchBanner),files);await write(input.outputRoot,"runtime-context.json",`${JSON.stringify(runtimeContext,null,2)}\n`,files);
  await write(input.outputRoot,"settings.json",`${JSON.stringify({statusLine:{type:"command",command:"node \"${CLAUDE_PLUGIN_ROOT}/status/status-line.mjs\""},mpxArtifactKey:input.artifact.reference.artifactKey},null,2)}\n`,files);
  return {directory:input.outputRoot,artifactKey:input.artifact.reference.artifactKey,files:files.sort()};
 }catch(error){await rm(input.outputRoot,{recursive:true,force:true});throw error;}
}
export async function publishClaudeProjection(input:ClaudePublishInput):Promise<ClaudePublishedProjection>{
 const context=parseRuntimeContextV1(input.runtimeContext),manifest=parseResolvedSkillManifestV4(input.manifest);await mkdir(input.artifactsRoot,{recursive:true});const staging=await mkdtemp(path.join(input.artifactsRoot,".claude-build-"));await rm(staging,{recursive:true,force:true});try{
  await buildClaudePlugin({...input,outputRoot:staging});
  const published=await publishRuntimeArtifact({sourceRoot:staging,artifactsRoot:input.artifactsRoot,launchBinding:{launchKey:context.launchKey,descriptorDigest:context.launchDescriptor.digest,runtimeArtifactKey:input.artifact.reference.artifactKey,runtime:"claude",manifestKey:manifest.manifestKey},...(input.artifactRevalidator?{revalidate:input.artifactRevalidator}:{})});
  const validation=await validateRuntimeContext({context,expectedLaunch:{launchKey:context.launchKey,descriptorDigest:context.launchDescriptor.digest},expectedManifestKey:manifest.manifestKey,expectedRuntimeArtifact:input.artifact.reference,currentBinding:manifest.binding});if(!validation.valid)throw new ClaudeRuntimeError("PUBLISHED_ARTIFACT_INVALID",validation.diagnostics.map(item=>item.code).join(","));
  const directory=path.resolve(published.directory),reference=Object.freeze({...published.reference,launchBinding:Object.freeze({...published.reference.launchBinding})});return Object.freeze({directory,pluginDirectory:directory,reference,artifactKey:reference.projectionKey,files:Object.freeze(published.fileMap.map(file=>file.path)),reused:published.reused});
 }finally{await rm(staging,{recursive:true,force:true});}
}
export function adaptClaudePreBash(command:string,manager:PackageManager|null){const danger=classifyDangerousCommand(command);return danger.action==="block"?danger:evaluatePackagePolicy(command,manager);}
export function renderClaudeStatusLine(value:unknown,input:{launchBanner:string}):string{const snapshot=parseStatusSnapshotV1(value);return `${input.launchBanner} | ${renderClaudePortSegment(snapshot)}`;}
export function diagnoseLegacyNamespaceConflicts(pluginNames:readonly string[]):RuntimeContractDiagnostic[]{const conflicts=pluginNames.filter(x=>x==="mp"||x==="mp-gh"||x.startsWith("mp:")||x.startsWith("mp-gh:"));if(conflicts.length)throw new ClaudeRuntimeError("LEGACY_NAMESPACE_CONFLICT",`legacy Claude namespace conflicts with mpx: ${conflicts.sort().join(", ")}`);return [];}
export interface ClaudeInvocationInput {readonly executable:string;readonly pluginDirectory?:string;readonly projection?:ClaudePublishedProjection;readonly accountRoot:string;readonly runtimeContext:unknown;readonly projectionReference?:PublishedRuntimeArtifactReference;readonly statusSnapshotPath?:string;readonly mcpConfigPaths?:readonly string[];readonly environment:Readonly<Record<string,string|undefined>>;readonly legacyPluginNames?:readonly string[];readonly lifecycle?:{readonly eventDirectory:string;readonly binding:unknown};readonly resumeTarget?:NativeSessionRefV1}
export interface ClaudeInvocationPlan {readonly executable:string;readonly args:readonly string[];readonly env:Readonly<Record<string,string>>}
function absolute(value:string|undefined,label:string):string{if(typeof value!=="string"||!value.trim()||(!path.win32.isAbsolute(value)&&!path.posix.isAbsolute(value)))throw new ClaudeRuntimeError("UNTRUSTED_PATH",`${label} must be absolute`);return value;}
function samePath(left:string,right:string):boolean{const canonical=(value:string)=>path.win32.isAbsolute(value)?path.win32.normalize(value).toLowerCase():path.posix.normalize(value);return canonical(left)===canonical(right);}
export function createClaudeInvocationPlan(input:ClaudeInvocationInput):ClaudeInvocationPlan{
 if(typeof input.accountRoot!=="string"||!input.accountRoot.trim())throw new ClaudeRuntimeError("NATIVE_ROOT_REQUIRED","privately selected Claude account root is required");
 if(!path.win32.isAbsolute(input.accountRoot)&&!path.posix.isAbsolute(input.accountRoot))throw new ClaudeRuntimeError("NATIVE_ROOT_NOT_ABSOLUTE","privately selected Claude account root must be absolute");
 const executable=absolute(input.executable,"trusted Claude executable"),pluginDirectory=absolute(input.projection?.pluginDirectory??input.pluginDirectory,"immutable Claude plugin directory"),accountRoot=input.accountRoot,projectionReference=input.projection?.reference??input.projectionReference;
 if(!projectionReference)throw new ClaudeRuntimeError("PROJECTION_REFERENCE_REQUIRED","published Claude projection reference is required");
 if(input.projection&&(!samePath(input.projection.directory,pluginDirectory)||input.projection.artifactKey!==projectionReference.projectionKey))throw new ClaudeRuntimeError("PROJECTION_BINDING_INVALID","published Claude projection binding is invalid");
 diagnoseLegacyNamespaceConflicts(input.legacyPluginNames??[]);
 const inheritedRoot=input.environment.CLAUDE_CONFIG_DIR;if(inheritedRoot!==undefined&&!samePath(accountRoot,absolute(inheritedRoot,"inherited Claude account root")))throw new ClaudeRuntimeError("NATIVE_ROOT_MISMATCH","selected Claude account root conflicts with the inherited Claude config root");
 const mcpConfigs=input.mcpConfigPaths??[];if(mcpConfigs.length>32)throw new ClaudeRuntimeError("MCP_CONFIG_INVALID","too many MCP configurations were selected");
 const mcpArgs=mcpConfigs.flatMap(config=>["--mcp-config",absolute(config,"validated MCP configuration")]);
 const resume=input.resumeTarget;if(resume&&(resume.kind!=="native-id"||typeof resume.value!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(resume.value)))throw new ClaudeRuntimeError("RESUME_TARGET_INVALID","Claude resume requires a validated native session id");
 const lifecycle=input.lifecycle,lifecycleBinding=lifecycle?validateSessionLifecycleBindingV1({binding:lifecycle.binding,context:input.runtimeContext,runtime:"claude",projectionReference}):undefined;
 return {executable,args:["--plugin-dir",pluginDirectory,...mcpArgs,...(mcpConfigs.length?["--strict-mcp-config"]:[]),...(resume?["--resume",resume.value]:[])],env:{CLAUDE_CONFIG_DIR:accountRoot,MPX_RUNTIME_CONTEXT:stable(input.runtimeContext),MPX_RUNTIME_PROJECTION_REFERENCE:stable(projectionReference),...(input.statusSnapshotPath?{MPX_STATUS_SNAPSHOT_FILE:absolute(input.statusSnapshotPath,"status snapshot")}: {}),...(lifecycle&&lifecycleBinding?{MPX_SESSION_LIFECYCLE_EVENT_DIR:absolute(lifecycle.eventDirectory,"lifecycle event directory"),MPX_SESSION_LIFECYCLE_BINDING_ID:lifecycleBinding.bindingId}:{})}};
}
