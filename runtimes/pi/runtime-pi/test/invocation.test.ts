import { expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeContextV1, createSessionLifecycleBindingV1 } from "@mpx/runtime-contracts";
import { planPiInvocation, verifyPiResumeTarget } from "../src/index.js";

const runtimeContext = createRuntimeContextV1({
  launchKey: "a".repeat(64),
  launchDescriptor: { reference: "launch.json", digest: "b".repeat(64) },
  manifestKey: "c".repeat(64),
  runtimeArtifact: { schemaVersion: 4, runtime: "pi", manifestKey: "c".repeat(64), artifactKey: "d".repeat(64), fileMapHash: "e".repeat(64) },
  binding: { projectId: "sample/app", repositoryId: "sample/app", contentScope: "work" },
});

it("creates a hermetic Pi invocation with launch-current-compatible runtime-context JSON", () => {
  const plan = planPiInvocation({ executable: "C:/trusted/pi.cmd", extension: "C:/artifacts/pi-extension.js", theme: "green", accountRoot: "C:/native/pi/account-a", immutableProjectionDirectory: "C:/artifacts/pi", runtimeContextFile: "C:/launch/context.json", runtimeContext, cwd: "C:/repo" });
  expect(plan).toEqual({
    executable: "C:/trusted/pi.cmd",
    cwd: "C:/repo",
    args: ["--no-extensions", "--extension", "C:/artifacts/pi-extension.js", "--no-skills", "--theme", "green"],
    env: {
      PI_CODING_AGENT_DIR: "C:/native/pi/account-a",
      MPX_RUNTIME: "pi",
      MPX_RUNTIME_CONTEXT: JSON.stringify(runtimeContext),
      MPX_RUNTIME_CONTEXT_FILE: "C:/launch/context.json",
    },
  });
  expect(JSON.parse(plan.env.MPX_RUNTIME_CONTEXT)).toEqual(runtimeContext);
  expect(Object.keys(plan.env)).not.toEqual(expect.arrayContaining(["AUTH", "SESSION", "TRUST", "CACHE"]));
  expect(plan.args).not.toEqual(expect.arrayContaining(["--auth", "--session", "--trust", "--cache"]));
});

it("accepts only a module-verified regular Pi session beneath the exact account root",async()=>{const account=await mkdtemp(path.join(tmpdir(),"pi-resume-"));try{await mkdir(path.join(account,"sessions"));await writeFile(path.join(account,"sessions","session-a.jsonl"),"session");const verified=await verifyPiResumeTarget(account,{kind:"root-relative-file",value:"sessions/session-a.jsonl"});const base={executable:path.join(account,"pi.cmd"),extension:path.join(account,"extension.js"),theme:"green" as const,accountRoot:account,runtimeContextFile:path.join(account,"context.json"),runtimeContext,cwd:account};expect(planPiInvocation({...base,resumeTarget:verified}).args.slice(-2)).toEqual(["--session",path.join(account,"sessions","session-a.jsonl").replaceAll("\\","/")]);expect(()=>planPiInvocation({...base,resumeTarget:{} as typeof verified})).toThrow(/verified/u);expect(()=>planPiInvocation({...base,accountRoot:path.join(account,"other"),resumeTarget:verified})).toThrow(/account root/u);}finally{await rm(account,{recursive:true,force:true});}});
it("rejects escaped, missing, and symlinked Pi resume targets during async verification",async()=>{const account=await mkdtemp(path.join(tmpdir(),"pi-resume-reject-")),outside=await mkdtemp(path.join(tmpdir(),"pi-resume-outside-"));try{await mkdir(path.join(account,"sessions"));await writeFile(path.join(outside,"session"),"session");await symlink(path.join(outside,"session"),path.join(account,"sessions","linked"),"file");await expect(verifyPiResumeTarget(account,{kind:"root-relative-file",value:"../escape"})).rejects.toThrow(/resume/u);await expect(verifyPiResumeTarget(account,{kind:"root-relative-file",value:"sessions/missing"})).rejects.toThrow(/resume/u);await expect(verifyPiResumeTarget(account,{kind:"root-relative-file",value:"sessions/linked"})).rejects.toThrow(/resume/u);}finally{await Promise.all([rm(account,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]);}});
it("injects only a full validated Pi lifecycle binding id and directory",()=>{const binding=createSessionLifecycleBindingV1({bindingId:"binding-1",bindingRef:"ref",runtime:"pi",identityRef:"id",launchKey:runtimeContext.launchKey,launchDescriptorDigest:runtimeContext.launchDescriptor.digest,artifactKey:runtimeContext.runtimeArtifact.artifactKey,manifestKey:runtimeContext.manifestKey,projectRef:"p",repositoryRef:"r",worktreeRef:"w",createdAt:"2025-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"}),base={executable:"C:/trusted/pi.cmd",extension:"C:/artifacts/pi-extension.js",theme:"green" as const,accountRoot:"C:/native/pi/account-a",runtimeContextFile:"C:/launch/context.json",runtimeContext,cwd:"C:/repo"};expect(planPiInvocation({...base,lifecycle:{eventDirectory:"C:/events",binding}}).env).toMatchObject({MPX_SESSION_LIFECYCLE_BINDING_ID:"binding-1",MPX_SESSION_LIFECYCLE_EVENT_DIR:"C:/events"});expect(()=>planPiInvocation({...base,lifecycle:{eventDirectory:"C:/events",binding:{...binding,manifestKey:"wrong"}}})).toThrow(/BINDING_MISMATCH/u);});
it("binds the live status snapshot path only in the Pi child environment",()=>{const plan=planPiInvocation({executable:"C:/trusted/pi.cmd",extension:"C:/artifacts/pi-extension.js",theme:"green",accountRoot:"C:/native/pi/account-a",runtimeContextFile:"C:/launch/context.json",runtimeContext,cwd:"C:/repo",statusSnapshotPath:"C:/private/status/current.json"});expect(plan.env.MPX_STATUS_SNAPSHOT_FILE).toBe("C:/private/status/current.json");expect(plan.args.join(" ")).not.toContain("current.json");});

it("propagates the exact published projection reference as JSON", () => {
  const plan = planPiInvocation({
    executable: "C:/trusted/pi.cmd",
    accountRoot: "C:/native/pi/account-a",
    cwd: "C:/repo",
    runtimeContext,
    projection: {
      directory: "C:/artifacts/pi",
      extension: "C:/artifacts/pi/extension.mjs",
      runtimeContextFile: "C:/artifacts/pi/runtime-context.json",
      theme: "green",
      artifactKey: "d".repeat(64),
      reference: runtimeContext.runtimeArtifact,
      files: Object.freeze([]),
      reused: false,
      revalidation: { directory: "C:/artifacts/pi", reference: runtimeContext.runtimeArtifact },
    },
  });
  expect(plan.env.MPX_RUNTIME_PROJECTION_REFERENCE).toBe(JSON.stringify(runtimeContext.runtimeArtifact));
});
