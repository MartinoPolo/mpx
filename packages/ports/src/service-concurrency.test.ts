import { execFile as execFileCallback, fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Canonical, type JsonValue } from "@mpx/core";
import type { ProjectConfig } from "@mpx/config";
import { RegistryStore } from "./index.js";

const roots:string[]=[]; const children:ChildProcess[]=[]; const execFile=promisify(execFileCallback);
const temporary=async(prefix:string)=>{const root=await mkdtemp(path.join(tmpdir(),prefix));roots.push(root);return root;};
afterEach(async()=>{for(const child of children.splice(0)) if(child.exitCode===null) child.kill(); await Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true})));});
const workerPath=fileURLToPath(new URL("../test-fixtures/ensure-worker.mjs",import.meta.url));
const releaseWorkerPath=fileURLToPath(new URL("../test-fixtures/release-worker.mjs",import.meta.url));
const waitFor=<T extends {type:string}>(child:ChildProcess,type:string,timeoutMs=15_000)=>new Promise<T>((resolve,reject)=>{
  let stderr=""; child.stderr?.on("data",chunk=>{stderr+=String(chunk)});
  const timer=setTimeout(()=>finish(new Error(`Timed out waiting for ${type}. ${stderr}`)),timeoutMs);
  const message=(value:unknown)=>{if(typeof value==="object"&&value!==null&&(value as {type?:string}).type===type) finish(undefined,value as T)};
  const exit=(code:number|null)=>finish(new Error(`Worker exited with ${code} before ${type}. ${stderr}`));
  const finish=(error?:Error,value?:T)=>{clearTimeout(timer);child.off("message",message);child.off("exit",exit);error?reject(error):resolve(value!)};
  child.on("message",message);child.once("exit",exit);
});
const waitForExit=(child:ChildProcess)=>new Promise<number|null>((resolve,reject)=>{if(child.exitCode!==null)return resolve(child.exitCode);const timer=setTimeout(()=>reject(new Error("Worker exit timed out.")),15_000);child.once("exit",code=>{clearTimeout(timer);resolve(code)});});
async function createMainWorktree():Promise<string> {
  const root=await temporary("mpx-ensure-git-"), cwd=path.join(root,"main");
  await mkdir(cwd); await execFile("git",["init"],{cwd});
  await execFile("git",["config","user.email","ports-test@example.invalid"],{cwd}); await execFile("git",["config","user.name","MPX Ports Test"],{cwd});
  await writeFile(path.join(cwd,"tracked.txt"),"fixture\n"); await execFile("git",["add","tracked.txt"],{cwd}); await execFile("git",["commit","-m","fixture"],{cwd});
  return cwd;
}

describe("PortService multi-process allocation",()=>{
  it("returns one stable lease when concurrent services ensure the same worktree",async()=>{
    const stateRoot=await temporary("mpx-ensure-state-"), cwd=await createMainWorktree();
    const config:ProjectConfig={schemaVersion:1,project:{id:"concurrent/project"},repository:{provider:"generic",remote:"origin"},development:{services:{web:{scope:"checkout",port:{mode:"managed",preferred:5100},start:{type:"package-script",script:"dev"}}}}};
    const configHash=sha256Canonical(config as unknown as JsonValue);
    const workers=[0,1].map(()=>{const child=fork(workerPath,[],{stdio:["ignore","ignore","pipe","ipc"]});children.push(child);return child;});
    await Promise.all(workers.map((child)=>waitFor(child,"ready")));
    let releaseHolds=false; const pendingHolds:ChildProcess[]=[];
    const ensuring=workers.map((child)=>waitFor(child,"ensuring"));
    const completed=workers.map((child)=>waitFor<{type:"done";lease:{leaseId:string;slot:number;services:Record<string,number>}}>(child,"done"));
    for(const child of workers){
      child.on("message",message=>{if((message as {type?:string}).type==="holding"){if(releaseHolds)child.send({type:"continue"});else pendingHolds.push(child);}});
      child.send({type:"go",stateRoot,cwd,config,configHash});
    }
    await Promise.all(ensuring); releaseHolds=true; for(const child of pendingHolds) child.send({type:"continue"});
    const results=await Promise.all(completed);
    expect(await Promise.all(workers.map(waitForExit))).toEqual([0,0]);
    expect(new Set(results.map(({lease})=>lease.leaseId)).size).toBe(1);
    expect(results.map(({lease})=>({slot:lease.slot,services:lease.services}))).toEqual([{slot:0,services:{web:5100}},{slot:0,services:{web:5100}}]);
    expect((await new RegistryStore(stateRoot).read()).leases).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(cwd,".worktree-ports.json"),"utf8"))).toMatchObject({leaseId:results[0]!.lease.leaseId,services:{web:5100}});
  },30_000);

  it("serializes concurrent post-removal release across processes",async()=>{
    const stateRoot=await temporary("mpx-release-state-"),mainPath=await temporary("mpx-release-main-"),linkedPath=await temporary("mpx-release-linked-");
    const commonGitPath=path.join(mainPath,"common"),main={repositoryId:"repository",worktreeId:"main",path:mainPath,role:"main",commonGitPath,gitAdminPath:path.join(mainPath,"admin")};
    const configHash="a".repeat(64),linked={leaseId:"linked-lease",projectId:"lifecycle/project",repositoryId:"repository",worktreeId:"linked",worktreePath:linkedPath,role:"linked",slot:1,configHash,services:{web:5101},claims:[{port:5101,exclusive:true}],updatedAt:1,commonGitPath,gitAdminPath:path.join(linkedPath,"admin")};
    await new RegistryStore(stateRoot).write({schemaVersion:1,leases:[{leaseId:"main-lease",projectId:"lifecycle/project",repositoryId:"repository",worktreeId:"main",worktreePath:mainPath,role:"main",slot:0,configHash,services:{web:5100},claims:[{port:5100,exclusive:true}],updatedAt:1,commonGitPath,gitAdminPath:main.gitAdminPath},linked]});
    const captured={schemaVersion:1,leaseId:linked.leaseId,projectId:linked.projectId,repositoryId:linked.repositoryId,worktreeId:linked.worktreeId,worktreePath:linked.worktreePath,role:"linked",configHash,commonGitPath,gitAdminPath:linked.gitAdminPath};
    const workers=[0,1].map(()=>{const child=fork(releaseWorkerPath,[],{stdio:["ignore","ignore","pipe","ipc"]});children.push(child);return child;});
    await Promise.all(workers.map(child=>waitFor(child,"ready")));
    const completed=workers.map(child=>waitFor<{type:"done";result:{released:boolean}}>(child,"done"));
    for(const child of workers)child.send({type:"go",stateRoot,main,identity:captured});
    const results=await Promise.all(completed); await Promise.all(workers.map(child=>{child.disconnect();return waitForExit(child);}));
    expect(results.map(({result})=>result.released).sort()).toEqual([false,true]);
    expect((await new RegistryStore(stateRoot).read()).leases.map(({worktreeId})=>worktreeId)).toEqual(["main"]);
  },30_000);
});
