import { mkdir, mkdtemp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InstallerService, MemoryReceiptStore, NodeReceiptStore, type ImmutableRunnerAuthority, type InstalledRunnerEvidence, type RunnerFileVerifier } from "./index.js";
import type { ScheduledTaskAdapter, ScheduledTaskInspection } from "@mpx/windows";
const runner: InstalledRunnerEvidence={path:"C:\\_MP_apps\\mpx\\runner.exe",sha256:"a".repeat(64),version:"1.0.0"};
class Tasks implements ScheduledTaskAdapter { available=true; task?:ScheduledTaskInspection; calls:string[]=[]; async inspect(){this.calls.push("inspect");return this.task} async install(s:any){this.calls.push("install");this.task={...s,exists:true}} async remove(){this.calls.push("remove");this.task=undefined} }
const files:RunnerFileVerifier={verify:async()=>runner};
const authority:ImmutableRunnerAuthority={resolveInstalled:async()=>runner,verifyInstalled:async()=>runner};
class MutableAuthority implements ImmutableRunnerAuthority {
 current=runner;
 calls:string[]=[];
 tampered=false;
 async resolveInstalled(){this.calls.push("resolve");return this.current}
 async verifyInstalled(evidence:InstalledRunnerEvidence){this.calls.push("verify");if(this.tampered)throw Object.assign(new Error("tampered"),{code:"INSTALL_RUNNER_STALE"});return evidence}
}
async function verifyInstalledTask(metadata:Partial<Pick<ScheduledTaskInspection,"lastRunAt"|"lastResult">>,now="2025-01-01T00:10:00.000Z"){
 const tasks=new Tasks(),store=new MemoryReceiptStore(),service=new InstallerService({tasks,store,files,authority,currentUser:"me",cwd:"C:\\repo",now:()=>new Date(now)});
 const plan=await service.plan({componentId:"session-capture",runner});await service.apply(plan,plan.confirmationDigest);
 tasks.task={...tasks.task!,...metadata};
 return service.verify("session-capture");
}
describe("InstallerService",()=>{
 it("fails closed without immutable runner authority",async()=>{const service=new InstallerService({tasks:new Tasks(),store:new MemoryReceiptStore(),files,currentUser:"me",cwd:"C:\\repo"});await expect(service.plan({componentId:"session-capture",runner})).rejects.toMatchObject({code:"INSTALL_RUNNER_UNAVAILABLE"})});
 it("creates deterministic session-capture plans and applies idempotently",async()=>{const tasks=new Tasks(),store=new MemoryReceiptStore();const service=new InstallerService({tasks,store,files,authority,currentUser:"DOMAIN\\me",cwd:"C:\\repo"});const a=await service.plan({componentId:"session-capture",runner}),b=await service.plan({componentId:"session-capture",runner});expect(a).toEqual(b);await service.apply(a,a.confirmationDigest);await service.apply(a,a.confirmationDigest);expect(tasks.calls.filter(x=>x==="install")).toHaveLength(1)});
 it("reports an uninstalled capture as structured verification",async()=>{
  const installed=new MutableAuthority(),service=new InstallerService({tasks:new Tasks(),store:new MemoryReceiptStore(),authority:installed,currentUser:"me",cwd:"C:\\repo"});
  await expect(service.verify("session-capture")).resolves.toMatchObject({installed:false,healthy:false,issues:["receipt-missing","task-missing"]});
  expect(installed.calls).toEqual([]);
 });
 it("reports a successfully run scheduled capture as healthy",async()=>{await expect(verifyInstalledTask({lastRunAt:"2025-01-01T00:00:00.000Z",lastResult:0})).resolves.toMatchObject({installed:true,healthy:true,issues:[]})});
 it("re-resolves the active runner during verification after the selector switches",async()=>{
  const tasks=new Tasks(),store=new MemoryReceiptStore(),installed=new MutableAuthority();
  const service=new InstallerService({tasks,store,authority:installed,currentUser:"me",cwd:"C:\\repo"});
  const plan=await service.plan({componentId:"session-capture",runner});await service.apply(plan,plan.confirmationDigest);
  installed.calls=[];installed.current={...runner,path:"C:\\_MP_apps\\mpx\\releases\\replacement\\runner.exe",sha256:"b".repeat(64),version:"replacement"};
  await expect(service.verify("session-capture")).resolves.toMatchObject({installed:true,healthy:false,issues:expect.arrayContaining(["runner-drift"])});
  expect(installed.calls.slice(0,2)).toEqual(["resolve","verify"]);
 });
 it("reports runner drift when the installed runner is tampered after installation",async()=>{
  const tasks=new Tasks(),store=new MemoryReceiptStore(),installed=new MutableAuthority();
  const service=new InstallerService({tasks,store,authority:installed,currentUser:"me",cwd:"C:\\repo",now:()=>new Date("2025-01-01T00:10:00.000Z")});
  const plan=await service.plan({componentId:"session-capture",runner});await service.apply(plan,plan.confirmationDigest);
  tasks.task={...tasks.task!,lastRunAt:"2025-01-01T00:00:00.000Z",lastResult:0};installed.tampered=true;
  await expect(service.verify("session-capture")).resolves.toMatchObject({installed:true,healthy:false,issues:["runner-drift"]});
 });
 it("rejects a stale task action even when its digest matches the ownership receipt",async()=>{
  const tasks=new Tasks(),store=new MemoryReceiptStore(),installed=new MutableAuthority();
  const service=new InstallerService({tasks,store,authority:installed,currentUser:"me",cwd:"C:\\repo",now:()=>new Date("2025-01-01T00:10:00.000Z")});
  const plan=await service.plan({componentId:"session-capture",runner});const receipt=await service.apply(plan,plan.confirmationDigest);
  tasks.task={...tasks.task!,lastRunAt:"2025-01-01T00:00:00.000Z",lastResult:0};
  installed.current={...runner,path:"C:\\_MP_apps\\mpx\\releases\\replacement\\runner.exe",sha256:"b".repeat(64),version:"replacement"};
  await store.write({...receipt,runner:installed.current});
  await expect(service.verify("session-capture")).resolves.toMatchObject({installed:true,healthy:false,issues:["task-drift"]});
 });
 it("reports a capture older than two cadence intervals as stale",async()=>{await expect(verifyInstalledTask({lastRunAt:"2025-01-01T00:09:59.999Z",lastResult:0},"2025-01-01T00:30:00.000Z")).resolves.toMatchObject({installed:true,healthy:false,issues:["task-last-run-stale"]})});
 it("reports an implausibly future capture as stale",async()=>{await expect(verifyInstalledTask({lastRunAt:"2025-01-01T00:30:00.001Z",lastResult:0},"2025-01-01T00:10:00.000Z")).resolves.toMatchObject({installed:true,healthy:false,issues:["task-last-run-stale"]})});
 it("does not mark a run at the two-cadence boundary stale",async()=>{await expect(verifyInstalledTask({lastRunAt:"2025-01-01T00:00:00.000Z",lastResult:0},"2025-01-01T00:20:00.000Z")).resolves.toMatchObject({installed:true,healthy:true,issues:[]})});
 it("reports a nonzero scheduled capture result as failed",async()=>{await expect(verifyInstalledTask({lastRunAt:"2025-01-01T00:00:00.000Z",lastResult:1})).resolves.toMatchObject({installed:true,healthy:false,issues:["task-last-run-failed"]})});
 it("reports a scheduled capture with no last run as never run",async()=>{await expect(verifyInstalledTask({lastResult:0})).resolves.toMatchObject({installed:true,healthy:false,issues:["task-never-ran"]})});
 it("refuses a foreign same-named task",async()=>{const tasks=new Tasks();tasks.task={exists:true} as ScheduledTaskInspection;const service=new InstallerService({tasks,store:new MemoryReceiptStore(),files,authority,currentUser:"me",cwd:"C:\\repo"});const p=await service.plan({componentId:"session-capture",runner});await expect(service.apply(p,p.confirmationDigest)).rejects.toMatchObject({code:"INSTALL_FOREIGN_TASK"})});
 it("serializes concurrent recovery apply and uninstall without leaving a task without a receipt",async()=>{
  const tasks=new Tasks(),store=new MemoryReceiptStore();
  const service=new InstallerService({tasks,store,files,authority,currentUser:"me",cwd:"C:\\repo"});
  const installPlan=await service.plan({componentId:"session-capture",runner});
  await service.apply(installPlan,installPlan.confirmationDigest);
  const uninstallPlan=await service.planUninstall("session-capture");
  tasks.task=undefined;
  let releaseInstall!:()=>void;
  const installStarted=new Promise<void>(resolve=>{releaseInstall=resolve});
  let unblockInstall!:()=>void;
  const installBlocked=new Promise<void>(resolve=>{unblockInstall=resolve});
  tasks.install=async spec=>{releaseInstall();await installBlocked;tasks.task={...spec,exists:true}};
  const applying=service.apply(installPlan,installPlan.confirmationDigest);
  await installStarted;
  const uninstalling=service.uninstall(uninstallPlan,uninstallPlan.confirmationDigest);
  unblockInstall();
  await Promise.all([applying,uninstalling]);
  expect(tasks.task===undefined || await store.read("session-capture")!==undefined).toBe(true);
 });
 it("recovers an aged orphaned receipt operation lock without waiting",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"mpx-installer-lock-")),now=Date.now();
  const store=new NodeReceiptStore(directory,10,{now:()=>now,staleInitializationMilliseconds:100});
  const lock=path.join(directory,"session-capture.json.operation.lock");
  await mkdir(lock,{recursive:true});
  await utimes(lock,(now-1_000)/1_000,(now-1_000)/1_000);
  await expect(store.transaction("session-capture",async()=>true)).resolves.toBe(true);
 });
 it("prevents a delayed receipt lock initializer from disturbing its successor",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"mpx-installer-successor-"));let now=Date.now(),startFirst!:()=>void,resumeFirst!:()=>void,startSecond!:()=>void,resumeSecond!:()=>void;
  const firstStarted=new Promise<void>(resolve=>{startFirst=resolve}),firstResume=new Promise<void>(resolve=>{resumeFirst=resolve});
  const secondStarted=new Promise<void>(resolve=>{startSecond=resolve}),secondResume=new Promise<void>(resolve=>{resumeSecond=resolve});
  const first=new NodeReceiptStore(directory,2_000,{now:()=>now,staleInitializationMilliseconds:100,afterLockInitializerCreated:async()=>{startFirst();await firstResume;}});
  const delayed=first.transaction("session-capture",async()=>true);await firstStarted;now+=1_000;
  const second=new NodeReceiptStore(directory,2_000,{now:()=>now,staleInitializationMilliseconds:100});
  const succeeding=second.transaction("session-capture",async()=>{startSecond();await secondResume;return true});await secondStarted;
  resumeFirst();await expect(delayed).rejects.toMatchObject({code:"INSTALL_LOCK_OWNERSHIP_LOST"});
  await expect(stat(path.join(directory,"session-capture.json.operation.lock"))).resolves.toBeDefined();
  resumeSecond();await expect(succeeding).resolves.toBe(true);
 });
 it("persists ownership before installation so a failed install can be retried",async()=>{
  const tasks=new Tasks(),store=new MemoryReceiptStore();let fail=true;
  tasks.install=async spec=>{tasks.calls.push("install");if(fail){fail=false;throw new Error("injected install failure")}tasks.task={...spec,exists:true}};
  const service=new InstallerService({tasks,store,files,authority,currentUser:"me",cwd:"C:\\repo"}),plan=await service.plan({componentId:"session-capture",runner});
  await expect(service.apply(plan,plan.confirmationDigest)).rejects.toThrow("injected install failure");
  expect(await store.read("session-capture")).toMatchObject({taskSpecDigest:plan.taskSpecDigest});
  await expect(service.verify("session-capture")).resolves.toMatchObject({installed:false,issues:["task-missing"]});
  await service.apply(plan,plan.confirmationDigest);
  expect(tasks.task).toBeDefined();
 });
});
