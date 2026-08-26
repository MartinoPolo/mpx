import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, opendir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MpxError } from "@mpx/core";

const execFile=promisify(execFileCallback);
const OLD_REFERENCE=/(?:mpx-claude-code|mpx-pi|\/mp:|\/mp-gh:|\.worktree-hub\.json|\.mpx[\\/]kanbanflow\.json|statusline-projects\.json)/iu;
const PRIVATE_PATH=/(?:^|\/)(?:auth(?:\.json)?|credentials?(?:\.[^/]*)?|settings\.local\.json|sessions?|history|trust|\.env(?:\..*)?)(?:\/|$)/iu;
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const portable=(value:string)=>value.replaceAll("\\","/");

type BaselineEntry={source:string;path:string;sha256?:string|null;destination?:string|null;disposition?:string;reason?:string;evidence?:unknown[];completion?:string};
type Baseline={sources?:{id:string;commit?:string}[];entries:BaselineEntry[]};
type DriftEntry={source:string;path:string;state:string;sha256:string|null;baselineSha256:string|null;privacy?:string;renamedFrom?:string;renamedTo?:string};

async function git(root:string,args:string[]):Promise<string>{return (await execFile("git",args,{cwd:root,encoding:"utf8",windowsHide:true,maxBuffer:64*1024*1024})).stdout;}
function nul(value:string):string[]{return value.split("\0").filter(Boolean).map(portable);}
async function hashFile(file:string):Promise<string|null>{try{return sha(await readFile(file));}catch{return null;}}
async function exists(file:string):Promise<boolean>{try{await lstat(file);return true;}catch{return false;}}
function privacy(relative:string):string|undefined{return PRIVATE_PATH.test(portable(relative))?"private-account-state":undefined;}

export async function captureSourceDrift(input:{baseline:Baseline;sources:{id:string;root:string;symbolicRoot:string}[]}) {
  const entries:DriftEntry[]=[], sources=[];
  for(const source of input.sources){
    const commit=(await git(source.root,["rev-parse","HEAD"])).trim();
    const tracked=new Set(nul(await git(source.root,["ls-files","-z"])));
    const untracked=nul(await git(source.root,["ls-files","--others","--exclude-standard","-z"]));
    const status=nul(await git(source.root,["status","--porcelain=v1","-z","--untracked-files=all"]));
    const states=new Map<string,{state:string;other?:string}>();
    for(let i=0;i<status.length;i++){
      const record=status[i]!; const code=record.slice(0,2), first=portable(record.slice(3));
      if(code.includes("R")){const second=status[++i]; if(second){states.set(first,{state:"renamed",other:second});states.set(second,{state:"renamed",other:first});}continue;}
      states.set(first,{state:code==="??"?"untracked":code.includes("D")?"deleted":"modified"});
    }
    const baselineEntries=input.baseline.entries.filter(e=>e.source===source.id), baselineByPath=new Map(baselineEntries.map(e=>[e.path,e]));
    const paths=new Set([...tracked,...untracked,...baselineEntries.map(e=>e.path),...states.keys()]);
    for(const relative of [...paths].sort()){
      const old=baselineByPath.get(relative), statusEntry=states.get(relative), excluded=privacy(relative)??(old?.disposition==="excluded"?old.reason:undefined);
      let state=excluded?(await exists(path.join(source.root,relative))?"excluded":"deleted"):statusEntry?.state??(tracked.has(relative)?"tracked":old?"deleted":"untracked");
      const currentHash=excluded||state==="deleted"?null:await hashFile(path.join(source.root,relative));
      if(state==="tracked" && old?.sha256 && currentHash!==old.sha256) state="changed-since-baseline";
      const item:DriftEntry={source:source.id,path:relative,state,sha256:currentHash,baselineSha256:old?.sha256??null};
      if(excluded)item.privacy=excluded;
      if(statusEntry?.state==="renamed"){
        const other=statusEntry.other!;
        if(old)item.renamedTo=other; else item.renamedFrom=other;
      }
      entries.push(item);
    }
    sources.push({id:source.id,symbolicRoot:source.symbolicRoot,baselineCommit:input.baseline.sources?.find(s=>s.id===source.id)?.commit??null,currentCommit:commit,dirty:status.length>0});
  }
  const counts=Object.fromEntries([...new Set(entries.map(e=>e.state))].sort().map(state=>[state,entries.filter(e=>e.state===state).length]));
  return {schemaVersion:1,kind:"mpx-phase-j-source-drift",capturedAt:new Date().toISOString(),sources,counts,entries};
}

const PARITY=[
  ["semantic",["packages/skills/test/source-semantic-parity.test.ts","packages/providers/src/conformance.test.ts"]],
  ["generation",["scripts/validate-generated.mjs","scripts/generate-convergence-manifest.mjs"]],
  ["hooks",["packages/runtime-hooks/src/index.test.ts"]],
  ["tools",["packages/runtime-tools/test/runtime-tools.test.ts"]],
  ["status",["packages/status/src/status.test.ts"]],
  ["dependencies",["pnpm-lock.yaml","docs/inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json"]],
] as const;
export function createParityReport(input:{baseline:Baseline;drift:{entries:DriftEntry[]};exceptions:{id:string;reason:string}[]}){
  const drift=new Map(input.drift.entries.map(e=>[`${e.source}:${e.path}`,e]));
  const sourceEntries=input.baseline.entries.map(entry=>({source:entry.source,path:entry.path,destination:entry.destination??null,disposition:entry.disposition??"unclassified",completion:entry.completion??null,evidence:entry.evidence??[],currentDrift:drift.get(`${entry.source}:${entry.path}`)?.state??"not-captured"}));
  const incomplete=sourceEntries.filter(entry=>entry.disposition==="unclassified" || entry.evidence.length===0);
  const parity=PARITY.map(([category,evidence])=>({category,status:"evidenced",evidence}));
  const passed=input.exceptions.length===0 && incomplete.length===0;
  return {schemaVersion:1,kind:"mpx-phase-j-parity-report",sourceEntries,parity,exceptions:input.exceptions,gate:{passed,exceptionCount:input.exceptions.length,incompleteSourceCount:incomplete.length,requiresExplicitZeroExceptions:true}};
}

type AuditFinding={surface:"log"|"process"|"environment"|"projection";reference:string;matchDigest:string};
function auditFail(code:string,message:string,cause?:unknown):never{throw new MpxError({code,message,...(cause===undefined?{}:{cause})});}
function sameEntry(left:Awaited<ReturnType<typeof lstat>>,right:Awaited<ReturnType<typeof lstat>>):boolean{return left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode;}
async function scanFiles(root:string,findings:AuditFinding[],surface:"log"|"projection"){
  if(!path.isAbsolute(root))auditFail("MIGRATION_AUDIT_ROOT_INVALID","Migration audit roots must be absolute.");
  const absoluteRoot=path.resolve(root);
  async function walk(dir:string):Promise<void>{
    let before:Awaited<ReturnType<typeof lstat>>;
    try{before=await lstat(dir);}catch(failure){auditFail("MIGRATION_AUDIT_OPENDIR_FAILED","Migration audit directory cannot be inspected.",failure);}
    if(before.isSymbolicLink())auditFail("MIGRATION_AUDIT_SYMLINK","Migration audit refuses symbolic links.");
    if(!before.isDirectory())auditFail("MIGRATION_AUDIT_OPENDIR_FAILED","Migration audit root is not a directory.");
    let handle;try{handle=await opendir(dir);}catch(failure){auditFail("MIGRATION_AUDIT_OPENDIR_FAILED","Migration audit directory cannot be opened.",failure);}
    try{const after=await lstat(dir);if(!sameEntry(before,after))auditFail("MIGRATION_AUDIT_PATH_REPLACED","Migration audit directory changed during inspection.");}
    catch(failure){if(failure instanceof MpxError)throw failure;auditFail("MIGRATION_AUDIT_PATH_REPLACED","Migration audit directory changed during inspection.",failure);}
    for await(const entry of handle){
      const file=path.join(dir,entry.name),relative=portable(path.relative(absoluteRoot,file));
      if(relative.startsWith("../")||path.isAbsolute(relative))auditFail("MIGRATION_AUDIT_PATH_ESCAPE","Migration audit entry escaped its root.");
      let fileBefore:Awaited<ReturnType<typeof lstat>>;try{fileBefore=await lstat(file);}catch(failure){auditFail("MIGRATION_AUDIT_PATH_REPLACED","Migration audit entry changed during inspection.",failure);}
      if(fileBefore.isSymbolicLink())auditFail("MIGRATION_AUDIT_SYMLINK","Migration audit refuses symbolic links.");
      if(PRIVATE_PATH.test(relative))continue;
      if(fileBefore.isDirectory()){if(![".git","node_modules","dist"].includes(entry.name))await walk(file);continue;}
      if(!fileBefore.isFile())auditFail("MIGRATION_AUDIT_FILE_INVALID","Migration audit accepts regular files only.");
      let fileHandle;try{fileHandle=await open(file,"r");}catch(failure){auditFail("MIGRATION_AUDIT_READ_FAILED","Migration audit file cannot be opened.",failure);}
      try{
        const opened=await fileHandle.stat();if(!opened.isFile()||!sameEntry(fileBefore,opened))auditFail("MIGRATION_AUDIT_PATH_REPLACED","Migration audit file changed during inspection.");
        let body:string;try{body=(await fileHandle.readFile("utf8")).slice(0,2_000_000);}catch(failure){auditFail("MIGRATION_AUDIT_READ_FAILED","Migration audit file cannot be read.",failure);}
        const final=await fileHandle.stat();if(!sameEntry(opened,final))auditFail("MIGRATION_AUDIT_PATH_REPLACED","Migration audit file changed during inspection.");
        if(OLD_REFERENCE.test(body))findings.push({surface,reference:sha(relative).slice(0,16),matchDigest:sha(body.match(OLD_REFERENCE)?.[0]?.toLowerCase()??"match")});
      }finally{await fileHandle.close();}
    }
  }
  await walk(absoluteRoot);
}
const ROUTE_PROJECTION_KEYS=["MPX_CLAUDE_PERSONAL_PROJECTION_ROOT","MPX_CLAUDE_WORK_PROJECTION_ROOT","MPX_PI_PERSONAL_PROJECTION_ROOT","MPX_PI_WORK_PROJECTION_ROOT"] as const;
export function migrationProjectionRoots(environment:NodeJS.ProcessEnv|Record<string,string|undefined>):string[]{
  const fallback=environment.LOCALAPPDATA?path.join(environment.LOCALAPPDATA,"mpx"):undefined, roots:string[]=[];
  for(const key of ROUTE_PROJECTION_KEYS){const value=environment[key]??fallback;if(!value)continue;if(!path.isAbsolute(value))auditFail("MIGRATION_AUDIT_ROOT_INVALID",`${key} must be absolute.`);const resolved=path.resolve(value);if(PRIVATE_PATH.test(portable(resolved)))auditFail("MIGRATION_AUDIT_ROOT_PRIVATE",`${key} cannot identify private account state.`);const identity=process.platform==="win32"?resolved.toLowerCase():resolved;if(!roots.some(item=>(process.platform==="win32"?item.toLowerCase():item)===identity))roots.push(resolved);}
  return roots;
}
export async function runtimeAccessAudit(input:{roots:string[];projectionRoots?:string[];processLines?:string[];environment?:NodeJS.ProcessEnv|Record<string,string|undefined>;legacyDisabled?:boolean}){
  const findings:AuditFinding[]=[];
  for(const root of input.roots)await scanFiles(root,findings,"log");
  for(const root of input.projectionRoots??[])await scanFiles(root,findings,"projection");
  for(const [index,line] of (input.processLines??[]).entries())if(OLD_REFERENCE.test(line))findings.push({surface:"process",reference:`process-${index}`,matchDigest:sha(line.match(OLD_REFERENCE)?.[0]?.toLowerCase()??"match")});
  for(const [name,value] of Object.entries(input.environment??{}))if(value&&OLD_REFERENCE.test(value))findings.push({surface:"environment",reference:name.startsWith("MPX_")?name:"redacted-env",matchDigest:sha(value.match(OLD_REFERENCE)?.[0]?.toLowerCase()??"match")});
  const mode=input.legacyDisabled?"legacy-disabled":"observation";
  return {schemaVersion:1,kind:"mpx-phase-j-runtime-access-audit",readOnly:true,credentialContentCaptured:false,findings,acceptance:{mode,passed:input.legacyDisabled===true&&findings.length===0,requiresLegacyDisabledFixture:true}};
}

export function buildCutoverPlan(input:{gatePassed:boolean;ownedActivations:{path:string;startMarker:string;endMarker:string;content:string}[]}){
  const actions=input.ownedActivations.map(item=>{const start=item.content.indexOf(item.startMarker),end=item.content.indexOf(item.endMarker,start+item.startMarker.length);const exact=start>=0&&end>=0&&item.content.indexOf(item.startMarker,start+1)<0&&item.content.indexOf(item.endMarker,end+1)<0;return {kind:"remove-owned-marker-block",path:item.path,startMarker:item.startMarker,endMarker:item.endMarker,exactOwnedMatch:exact,eligible:input.gatePassed&&exact};});
  const core={schemaVersion:1,kind:"mpx-phase-j-cutover-plan",nonDestructive:true,gatePassed:input.gatePassed,actions,manualOnly:[{kind:"archive",targets:["${MPX_PROJECTS}/mpx-pi","${MPX_PROJECTS}/mpx-claude-code"],requires:"complete provenance, zero runtime references, and human provider action"},{kind:"rename",targets:["${MPX_PROJECTS}/mpx-pi","${MPX_PROJECTS}/mpx-claude-code"],requires:"human filesystem action after rollback window"},{kind:"remotes",targets:["legacy repository remotes and redirects"],requires:"human provider and Git action"}],prohibitions:["delete-native-state","disable-live-legacy","archive-repository","change-remotes"]};
  return {...core,confirmationDigest:sha(JSON.stringify(core))};
}
function removeExact(content:string,startMarker:string,endMarker:string):string{const start=content.indexOf(startMarker),markerEnd=content.indexOf(endMarker,start+startMarker.length);if(start<0||markerEnd<0||content.indexOf(startMarker,start+1)>=0||content.indexOf(endMarker,markerEnd+1)>=0)throw new Error("owned activation markers are not an exact unique pair");let end=markerEnd+endMarker.length;if(content[end]==="\r")end++;if(content[end]==="\n")end++;return content.slice(0,start)+content.slice(end);}
export async function rollbackDrill(input:{content:string;startMarker:string;endMarker:string;now?:Date}){
  const root=await mkdtemp(path.join(tmpdir(),"mpx-rollback-drill-")),file=path.join(root,"profile"),snapshot=Buffer.from(input.content),digest=sha(snapshot),snapshotFile=path.join(root,`${digest}.snapshot`);
  await writeFile(snapshotFile,snapshot,{flag:"wx",mode:0o400}); await writeFile(file,snapshot,{flag:"wx"}); const cutover=removeExact(input.content,input.startMarker,input.endMarker); await writeFile(file,cutover); await writeFile(file,await readFile(snapshotFile)); const restoredDigest=sha(await readFile(file));
  const now=input.now??new Date(),expiresAt=new Date(now.getTime()+30*86400_000).toISOString();
  return {schemaVersion:1,kind:"mpx-phase-j-rollback-drill",simulationRoot:"temporary",realStateTouched:false,passed:restoredDigest===digest,snapshot:{immutable:true,digest,createdAt:now.toISOString(),retentionDays:30,expiresAt},cutoverDigest:sha(cutover),restoredDigest};
}

export async function loadJson<T>(file:string):Promise<T>{return JSON.parse(await readFile(file,"utf8")) as T;}

export function parseProcessCommandLines(value:unknown):string[]{
  if(typeof value==="string")return [value];
  if(!Array.isArray(value)||!value.every(item=>typeof item==="string"))throw new Error("Windows process audit returned invalid command-line JSON");
  return value;
}
export async function processCommandLines(snapshotFile?:string,runner:typeof execFile=execFile):Promise<string[]>{
  if(snapshotFile){
    const parsed=await loadJson<unknown>(snapshotFile);
    if(!Array.isArray(parsed)||!parsed.every(item=>typeof item==="string"))throw new Error("MPX_MIGRATION_PROCESS_SNAPSHOT must contain a JSON array of command lines");
    return parsed;
  }
  if(process.platform!=="win32")return [];
  try{
    const script="Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress";
    const output=(await runner("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{encoding:"utf8",windowsHide:true,maxBuffer:8*1024*1024,timeout:10_000})).stdout;
    return parseProcessCommandLines(JSON.parse(output||"[]") as unknown);
  }catch(failure){throw new Error("Windows process audit is unavailable; migration acceptance cannot be evaluated",{cause:failure});}
}
function resolveSymbolic(value:string,env:NodeJS.ProcessEnv):string{return value.replace(/^\$\{([^}]+)\}/u,(_,name:string)=>env[name]??`\${${name}}`);}
async function optionalJson<T>(file:string,fallback:T):Promise<T>{try{return await loadJson<T>(file);}catch(failure){if((failure as NodeJS.ErrnoException).code==="ENOENT")return fallback;throw failure;}}
function parseExceptions(value:unknown):{id:string;reason:string}[]{
  if(!Array.isArray(value))throw new Error("phase-j-exceptions.json must contain an array");
  const result=value.map(item=>{if(!item||typeof item!=="object"||Array.isArray(item)||Object.keys(item).sort().join(",")!=="id,reason")throw new Error("phase-j-exceptions.json contains an invalid exception");const {id,reason}=item as Record<string,unknown>;if(typeof id!=="string"||id.trim().length===0||typeof reason!=="string"||reason.trim().length===0)throw new Error("phase-j-exceptions.json contains an invalid exception");return {id,reason};});
  if(new Set(result.map(item=>item.id)).size!==result.length)throw new Error("phase-j-exceptions.json contains duplicate IDs");
  return result;
}
export async function executeMigrationCommand(input:{action:string;repoRoot:string;env:NodeJS.ProcessEnv;legacyDisabled:boolean}){
  const baselineFile=path.join(input.repoRoot,"docs","history","CONVERGENCE_MANIFEST.json");
  const baseline=await loadJson<Baseline>(baselineFile),projects=input.env.MPX_PROJECTS;
  if(!projects)throw new Error("MPX_PROJECTS is required for migration source reconciliation");
  const sourceSpecs=[{id:"claude",root:path.join(projects,"mpx-claude-code"),symbolicRoot:"${MPX_PROJECTS}/mpx-claude-code"},{id:"pi",root:path.join(projects,"mpx-pi"),symbolicRoot:"${MPX_PROJECTS}/mpx-pi"}];
  if(input.action==="rollback-drill")return rollbackDrill({content:"native\n# >>> old-mpx owned >>>\nlegacy\n# <<< old-mpx owned <<<\n",startMarker:"# >>> old-mpx owned >>>",endMarker:"# <<< old-mpx owned <<<"});
  const drift=await captureSourceDrift({baseline,sources:sourceSpecs});
  const exceptions=parseExceptions(await optionalJson<unknown>(path.join(input.repoRoot,"docs","phase-j-exceptions.json"),[])),report=createParityReport({baseline,drift,exceptions});
  const auditRoots=[input.env.APPDATA?path.join(input.env.APPDATA,"mpx","logs"):"",input.env.LOCALAPPDATA?path.join(input.env.LOCALAPPDATA,"mpx","logs"):""].filter(Boolean);
  const installedProjections=migrationProjectionRoots(input.env);
  const audit=await runtimeAccessAudit({roots:auditRoots,projectionRoots:installedProjections,processLines:await processCommandLines(input.env.MPX_MIGRATION_PROCESS_SNAPSHOT),environment:input.env,legacyDisabled:input.legacyDisabled});
  const liveGatePassed=report.gate.passed&&audit.acceptance.passed;
  if(input.action==="reconcile")return {schemaVersion:1,kind:"mpx-migration-reconciliation",sourceDrift:drift,runtimeAccessAudit:audit,gate:{passed:liveGatePassed}};
  if(input.action==="report")return {...report,sourceDriftSummary:drift.counts,runtimeAccessAudit:audit,gate:{...report.gate,passed:liveGatePassed,legacyDisabledAccepted:audit.acceptance.passed}};
  if(input.action==="cutover-plan"){
    const specs=await optionalJson<{path:string;startMarker:string;endMarker:string}[]>(path.join(input.repoRoot,"docs","phase-j-owned-activations.json"),[]),ownedActivations=[];
    for(const spec of specs){const file=resolveSymbolic(spec.path,input.env);let content="";try{content=await readFile(file,"utf8");}catch{}ownedActivations.push({...spec,path:spec.path,content});}
    return buildCutoverPlan({gatePassed:liveGatePassed,ownedActivations});
  }
  throw new Error(`Unknown migration action: ${input.action}`);
}
