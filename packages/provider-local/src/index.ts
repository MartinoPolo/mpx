import { createHash } from "node:crypto";
import { mkdir, lstat, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MpxError, type JsonValue } from "@mpx/core";
import { ISSUE_CAPABILITIES, LOCAL_ISSUE_CAPABILITIES, ProviderError, type IssueCommentV1, type IssueV1, type ProviderAdapter, type ProviderInvocation } from "@mpx/providers";

export type LocalRelationshipKind = "parent" | "children" | "related" | "duplicates";
export interface LocalRelationships { parent?: string; children: string[]; related: string[]; duplicates: string[] }
export interface LocalDependencies { dependsOn: string[]; blocks: string[]; frontier: string[]; cycle?: boolean }
export interface LocalIssue extends IssueV1 {
  readonly providerData: { readonly local: Readonly<Record<string, JsonValue>> };
}
export interface BoardPromotionAdapter { promote(issue: LocalIssue, destination: string): Promise<LocalIssue | void> }
export interface LocalIssueStoreOptions { staleLockMilliseconds?: number; promotion?: BoardPromotionAdapter }

export class LocalIssueError extends MpxError {
  constructor(code: string, message: string, details?: Record<string, JsonValue>) { super({ code, message, retryable: code === "LOCAL_ISSUE_CONFLICT", ...(details ? { details } : {}) }); this.name = "LocalIssueError"; }
}

interface Document {
  id: string; title: string; state: "open" | "finished"; localState: string; labels: string[];
  relationships: LocalRelationships; dependencies: { dependsOn: string[]; blocks: string[] };
  createdAt: string; updatedAt: string; body: string; preservedBody: string; unknown: string[]; revision: string;
}
const safeId = /^(?:0|[1-9][0-9]{0,15})$/u;
const knownKeys = new Set(["schemaVersion", "id", "title", "state", "localState", "labels", "relationships", "dependencies", "createdAt", "updatedAt"]);
const marker = "<!-- mpx:preserve -->";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const uniqueIds = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === "string" && safeId.test(item)) ? [...new Set(value)].sort((a,b)=>Number(a)-Number(b)) : [];

async function assertNoSymlink(candidate: string): Promise<void> {
  const absolute = path.resolve(candidate), parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new LocalIssueError("LOCAL_ISSUE_PATH_UNSAFE", "Local issue paths may not contain symbolic links."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
function issuePath(root: string, id: string): string {
  if (!safeId.test(id)) throw new LocalIssueError("LOCAL_ISSUE_PATH_UNSAFE", "The local issue identifier is unsafe.");
  const result = path.join(root, `${id}.md`);
  if (path.dirname(result) !== root) throw new LocalIssueError("LOCAL_ISSUE_PATH_UNSAFE", "The local issue path escaped its configured root.");
  return result;
}
function malformed(): LocalIssueError { return new LocalIssueError("LOCAL_ISSUE_MALFORMED", "The local issue document is malformed."); }
function parseDocument(text: string, expectedId: string): Document {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text);
  if (!match) throw malformed();
  const values: Record<string, unknown> = {}, unknown: string[] = [];
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*)(.*)$/u.exec(line);
    if (!field) { unknown.push(line); continue; }
    if (!knownKeys.has(field[1]!)) { unknown.push(line); continue; }
    try { values[field[1]!] = JSON.parse(field[2]!); } catch { throw malformed(); }
  }
  if (values.schemaVersion !== 1 || values.id !== expectedId || typeof values.title !== "string" || !["open","finished"].includes(String(values.state)) || typeof values.localState !== "string" || !Array.isArray(values.labels) || !values.labels.every(v=>typeof v==="string") || typeof values.createdAt !== "string" || typeof values.updatedAt !== "string") throw malformed();
  const relationships = values.relationships as Record<string, unknown> | undefined;
  const dependencies = values.dependencies as Record<string, unknown> | undefined;
  if (relationships !== undefined && (typeof relationships !== "object" || relationships === null) || dependencies !== undefined && (typeof dependencies !== "object" || dependencies === null)) throw malformed();
  const rawBody = match[2]!, markerAt = rawBody.indexOf(marker);
  return {
    id: expectedId, title: values.title, state: values.state as "open"|"finished", localState: values.localState,
    labels: [...new Set(values.labels as string[])].sort(),
    relationships: { ...(typeof relationships?.parent === "string" && safeId.test(relationships.parent) ? { parent: relationships.parent } : {}), children: uniqueIds(relationships?.children), related: uniqueIds(relationships?.related), duplicates: uniqueIds(relationships?.duplicates) },
    dependencies: { dependsOn: uniqueIds(dependencies?.dependsOn), blocks: uniqueIds(dependencies?.blocks) },
    createdAt: values.createdAt, updatedAt: values.updatedAt,
    body: markerAt < 0 ? rawBody : rawBody.slice(0, markerAt).trimEnd(), preservedBody: markerAt < 0 ? "" : rawBody.slice(markerAt), unknown, revision: digest(text),
  };
}
function encode(document: Omit<Document,"revision">): string {
  const fields: [string, unknown][] = [["schemaVersion",1],["id",document.id],["title",document.title],["state",document.state],["localState",document.localState],["labels",document.labels],["relationships",document.relationships],["dependencies",document.dependencies],["createdAt",document.createdAt],["updatedAt",document.updatedAt]];
  const frontmatter = [...fields.map(([key,value])=>`${key}: ${JSON.stringify(value)}`), ...document.unknown].join("\n");
  const body = document.preservedBody ? `${document.body.trimEnd()}\n\n${document.preservedBody}` : document.body;
  return `---\n${frontmatter}\n---\n${body}`;
}
async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try { await writeFile(temporary, text, { encoding: "utf8", flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }).catch(()=>undefined); }
}

export class LocalIssueStore {
  readonly root: string; readonly options: Required<Pick<LocalIssueStoreOptions,"staleLockMilliseconds">> & LocalIssueStoreOptions;
  constructor(root: string, options: LocalIssueStoreOptions = {}) {
    if (!path.isAbsolute(root)) throw new LocalIssueError("LOCAL_ISSUE_ROOT_INVALID", "The local issue root must be absolute.");
    const resolved = path.resolve(root);
    if (/(?:^|[\\/])(?:\.git|\.mpx|node_modules)(?:[\\/]|$)/ui.test(resolved)) throw new LocalIssueError("LOCAL_ISSUE_ROOT_INVALID", "The local issue root may not be private native state.");
    this.root = resolved; this.options = { staleLockMilliseconds: options.staleLockMilliseconds ?? 30_000, ...options };
  }
  async #ready(): Promise<void> { await assertNoSymlink(this.root); await mkdir(this.root, { recursive: true }); await assertNoSymlink(this.root); }
  async #locked<T>(operation: ()=>Promise<T>): Promise<T> {
    await this.#ready(); const lock = path.join(this.root, ".mpx-issues.lock"), deadline = Date.now()+5000;
    while (true) {
      try { const handle = await open(lock,"wx"); await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:Date.now()})); await handle.close(); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try { if (Date.now()-(await stat(lock)).mtimeMs > this.options.staleLockMilliseconds) { await rm(lock,{force:true}); continue; } } catch { continue; }
        if (Date.now()>deadline) throw new LocalIssueError("LOCAL_ISSUE_LOCK_TIMEOUT","Timed out waiting for the local issue lock.");
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    }
    try { return await operation(); } finally { await rm(lock,{force:true}); }
  }
  async #read(id: string): Promise<Document> { await this.#ready(); const file=issuePath(this.root,id); await assertNoSymlink(file); try { return parseDocument(await readFile(file,"utf8"),id); } catch(error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") throw new LocalIssueError("LOCAL_ISSUE_NOT_FOUND",`Local issue ${id} was not found.`); throw error; } }
  async #frontier(id:string, direct:string[]):Promise<{frontier:string[];cycle:boolean}> {
    const leaves=new Set<string>(), visiting=new Set<string>(), seen=new Set<string>(); let cycle=false;
    const walk=async(current:string):Promise<void>=>{ if(current===id||visiting.has(current)){cycle=true;return;} if(seen.has(current))return; visiting.add(current); seen.add(current); let doc:Document; try{doc=await this.#read(current);}catch{return;} if(doc.state==="finished"){visiting.delete(current);return;} if(doc.dependencies.dependsOn.length===0)leaves.add(current); else for(const next of doc.dependencies.dependsOn)await walk(next); visiting.delete(current); };
    for(const dependency of direct)await walk(dependency); return {frontier:cycle?[]:[...leaves].sort((a,b)=>Number(a)-Number(b)),cycle};
  }
  async #normalized(document:Document):Promise<LocalIssue>{ const derived=await this.#frontier(document.id,document.dependencies.dependsOn); return {schemaVersion:1,id:document.id,title:document.title,body:document.body,state:document.state,labels:document.labels,providerData:{local:{nativeId:document.id,localState:document.localState,relationships:document.relationships as unknown as JsonValue,dependencies:{...document.dependencies,frontier:derived.frontier,...(derived.cycle?{cycle:true}:{})} as unknown as JsonValue,createdAt:document.createdAt,updatedAt:document.updatedAt,revision:document.revision}}}; }
  async list(state?:"open"|"finished"):Promise<LocalIssue[]>{ await this.#ready(); const names=(await readdir(this.root)).filter(name=>/^(?:0|[1-9][0-9]{0,15})\.md$/u.test(name)).sort((a,b)=>Number.parseInt(a)-Number.parseInt(b)); const result=[]; for(const name of names){const item=await this.view(name.slice(0,-3));if(!state||item.state===state)result.push(item);} return result; }
  async view(id:string):Promise<LocalIssue>{ return this.#normalized(await this.#read(id)); }
  async create(input:{title:string;body:string;labels?:string[];localState?:string}):Promise<LocalIssue>{
    return this.#locked(async()=>{ const counter=path.join(this.root,".mpx-index.json"); let next=1; try{const parsed=JSON.parse(await readFile(counter,"utf8"));if(Number.isSafeInteger(parsed.next)&&parsed.next>0)next=parsed.next;}catch{} const existing=(await readdir(this.root)).flatMap(name=>/^(\d+)\.md$/u.exec(name)?.[1]??[]).map(Number); next=Math.max(next,...existing.map(value=>value+1)); const id=String(next),now=new Date().toISOString(); const document:Omit<Document,"revision">={id,title:input.title,state:"open",localState:input.localState??"todo",labels:[...new Set(input.labels??[])].sort(),relationships:{children:[],related:[],duplicates:[]},dependencies:{dependsOn:[],blocks:[]},createdAt:now,updatedAt:now,body:input.body,preservedBody:"",unknown:[]}; await atomicWrite(issuePath(this.root,id),encode(document)); await atomicWrite(counter,JSON.stringify({schemaVersion:1,next:next+1})); return this.view(id); });
  }
  async update(id:string,patch:{title?:string;body?:string;state?:"open"|"finished";localState?:string;labels?:string[];relationships?:Partial<LocalRelationships>},expectedRevision?:string):Promise<LocalIssue>{
    return this.#locked(async()=>{const current=await this.#read(id);if(expectedRevision!==undefined&&current.revision!==expectedRevision)throw new LocalIssueError("LOCAL_ISSUE_CONFLICT","The local issue changed since it was read.",{id}); const now=new Date().toISOString(), document:Omit<Document,"revision">={...current,...patch,labels:patch.labels?[...new Set(patch.labels)].sort():current.labels,relationships:{...current.relationships,...patch.relationships},body:patch.body??current.body,preservedBody:current.preservedBody,updatedAt:now}; await atomicWrite(issuePath(this.root,id),encode(document)); return this.view(id);});
  }
  async setDependency(id:string,dependencyId:string,present:boolean,expectedRevision?:string):Promise<LocalIssue>{
    if(id===dependencyId)throw new LocalIssueError("LOCAL_ISSUE_DEPENDENCY_INVALID","An issue cannot directly depend on itself.");
    return this.#locked(async()=>{const current=await this.#read(id), dependency=await this.#read(dependencyId);if(expectedRevision&&current.revision!==expectedRevision)throw new LocalIssueError("LOCAL_ISSUE_CONFLICT","The local issue changed since it was read."); const dependsOn=present?[...new Set([...current.dependencies.dependsOn,dependencyId])].sort((a,b)=>Number(a)-Number(b)):current.dependencies.dependsOn.filter(value=>value!==dependencyId); const blocks=present?[...new Set([...dependency.dependencies.blocks,id])].sort((a,b)=>Number(a)-Number(b)):dependency.dependencies.blocks.filter(value=>value!==id); const now=new Date().toISOString(); await atomicWrite(issuePath(this.root,id),encode({...current,dependencies:{...current.dependencies,dependsOn},updatedAt:now})); await atomicWrite(issuePath(this.root,dependencyId),encode({...dependency,dependencies:{...dependency.dependencies,blocks},updatedAt:now})); return this.view(id);});
  }
  async comment(id:string,body:string):Promise<IssueCommentV1>{return this.#locked(async()=>{const current=await this.#read(id),createdAt=new Date().toISOString(),commentId=`${id}-${Date.parse(createdAt)}`;const preserved=current.preservedBody||marker;const section=`\n\n## Comment ${commentId}\n${body}`;await atomicWrite(issuePath(this.root,id),encode({...current,preservedBody:preserved+section,updatedAt:createdAt}));return {schemaVersion:1,id:commentId,issueId:id,body,createdAt,providerData:{local:{nativeId:commentId}}};});}
  async promote(id:string,destination:string):Promise<LocalIssue>{if(!this.options.promotion)throw new ProviderError("CAPABILITY_UNSUPPORTED","Local issues have no configured board promotion adapter.",{capability:"issue.move"});const issue=await this.view(id), result=await this.options.promotion.promote(issue,destination);return result??issue;}
}

export function createLocalIssueAdapter(options:{root:string;staleLockMilliseconds?:number;promotion?:BoardPromotionAdapter}):ProviderAdapter {
  const store=new LocalIssueStore(options.root,options);
  const capabilities=[...ISSUE_CAPABILITIES,...LOCAL_ISSUE_CAPABILITIES];
  return {providerId:"local",role:"issues",backend:"filesystem",capabilities:capabilities as ProviderAdapter["capabilities"],routeRequired:false,async invoke(request:ProviderInvocation):Promise<unknown>{const input=request.input as Record<string,unknown>;switch(request.capability){case"issue.list":return store.list(input.state as "open"|"finished"|undefined);case"issue.view":return store.view(String(input.id));case"issue.create":return store.create({title:String(input.title),body:String(input.body)});case"issue.edit":return store.update(String(input.id),{title:String(input.title),body:String(input.body)},typeof input.revision==="string"?input.revision:undefined);case"issue.comment":return store.comment(String(input.id),String(input.body));case"issue.label":{const issue=await store.view(String(input.id));return store.update(issue.id,{labels:[...issue.labels,String(input.label)]},String(issue.providerData.local.revision));}case"issue.finish":return store.update(String(input.id),{state:"finished",localState:"done"},typeof input.revision==="string"?input.revision:undefined);case"issue.move":return store.promote(String(input.id),String(input.destination));case"issue.dependency.add":return store.setDependency(String(input.id),String(input.dependencyId),true,typeof input.revision==="string"?input.revision:undefined);case"issue.dependency.remove":return store.setDependency(String(input.id),String(input.dependencyId),false,typeof input.revision==="string"?input.revision:undefined);default:throw new ProviderError("CAPABILITY_UNSUPPORTED",`Local issues do not support ${request.capability}.`,{capability:request.capability});}}};
}

export interface ObsidianIssueViewConfig { vaultRoot:string; outputRoot:string; projectId:string; resumeBaseUrl:string }
export async function rebuildObsidianIssueViews(store:LocalIssueStore,config:ObsidianIssueViewConfig):Promise<{generated:number;removed:number}>{
  const vault=path.resolve(config.vaultRoot),output=path.resolve(config.outputRoot),relative=path.relative(vault,output);
  if(!path.isAbsolute(config.vaultRoot)||relative===""||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||!/^MPX(?:[\\/]|$)/u.test(relative)||!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(config.projectId)||!/^mpx:\/\/[A-Za-z0-9/?&=._%-]+$/u.test(config.resumeBaseUrl))throw new LocalIssueError("LOCAL_VIEW_CONFIG_INVALID","Obsidian issue views require a safe MPX vault subtree and resume URL.");
  await assertNoSymlink(vault);await mkdir(output,{recursive:true});await assertNoSymlink(output);const issues=await store.list(),expected=new Set(issues.map(issue=>`${issue.id}.md`));let removed=0;
  for(const name of await readdir(output)){if(/^\d+\.md$/u.test(name)&&!expected.has(name)){await rm(path.join(output,name));removed++;}}
  for(const issue of issues){const local=issue.providerData.local,dependencies=local.dependencies as unknown as LocalDependencies;const url=`${config.resumeBaseUrl}${config.resumeBaseUrl.includes("?")?"&":"?"}project=${encodeURIComponent(config.projectId)}&issue=${encodeURIComponent(issue.id)}`;const text=`---\nmpxGenerated: true\nproject: ${JSON.stringify(config.projectId)}\nissue: ${JSON.stringify(issue.id)}\nstate: ${JSON.stringify(issue.state)}\n---\n# ${issue.id}: ${issue.title}\n\n- State: ${issue.state}\n- Labels: ${issue.labels.join(", ")||"none"}\n- Dependency frontier: ${dependencies.frontier.join(", ")||"clear"}\n- [Resume](${url})\n`;await atomicWrite(path.join(output,`${issue.id}.md`),text);}
  return {generated:issues.length,removed};
}

export interface PrivacySafeSessionView {
  id: string; projectId: string; status: string; title: string; resumeUrl: string;
  /** Accepted for caller convenience but deliberately never projected. */ privateSummary?: string;
}
export interface ObsidianSessionViewConfig { vaultRoot:string; outputRoot:string }
export async function rebuildObsidianSessionViews(sessions:readonly PrivacySafeSessionView[],config:ObsidianSessionViewConfig):Promise<{generated:number;removed:number}>{
  const vault=path.resolve(config.vaultRoot),output=path.resolve(config.outputRoot),relative=path.relative(vault,output);
  if(!path.isAbsolute(config.vaultRoot)||relative===""||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||!/^MPX(?:[\\/]|$)/u.test(relative))throw new LocalIssueError("LOCAL_VIEW_CONFIG_INVALID","Session views require a configured MPX vault subtree.");
  const safe=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  for(const session of sessions)if(!safe.test(session.id)||!safe.test(session.status)||!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(session.projectId)||session.title.length>256||!/^mpx:\/\/[A-Za-z0-9/?&=._%-]+$/u.test(session.resumeUrl))throw new LocalIssueError("LOCAL_VIEW_CONFIG_INVALID","Session view metadata or resume link is invalid.");
  await assertNoSymlink(vault);await mkdir(output,{recursive:true});await assertNoSymlink(output);const expected=new Set(sessions.map(session=>`${session.id}.md`));let removed=0;
  for(const name of await readdir(output)){if(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/u.test(name)&&!expected.has(name)){await rm(path.join(output,name));removed++;}}
  for(const session of sessions){const text=`---\nmpxGenerated: true\nkind: session\nproject: ${JSON.stringify(session.projectId)}\nsession: ${JSON.stringify(session.id)}\nstatus: ${JSON.stringify(session.status)}\n---\n# ${session.title}\n\n- Status: ${session.status}\n- [Resume](${session.resumeUrl})\n`;await atomicWrite(path.join(output,`${session.id}.md`),text);}
  return {generated:sessions.length,removed};
}
