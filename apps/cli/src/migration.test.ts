import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildCutoverPlan, captureSourceDrift, createParityReport, rollbackDrill, runtimeAccessAudit } from "./migration.js";

const exec = promisify(execFile);
async function gitFixture(): Promise<string> {
  const root=await mkdtemp(path.join(tmpdir(),"mpx-j-source-"));
  await exec("git",["init"],{cwd:root}); await exec("git",["config","user.email","test@example.invalid"],{cwd:root}); await exec("git",["config","user.name","Test"],{cwd:root});
  await mkdir(path.join(root,"private")); await writeFile(path.join(root,"kept.txt"),"before"); await writeFile(path.join(root,"private","auth.json"),"SECRET");
  await exec("git",["add","."],{cwd:root}); await exec("git",["commit","-m","base"],{cwd:root});
  return root;
}

describe("Phase J migration reconciliation",()=>{
  it("captures tracked, dirty, deleted, renamed, and untracked drift without private content",async()=>{
    const root=await gitFixture();
    await exec("git",["mv","kept.txt","renamed.txt"],{cwd:root}); await writeFile(path.join(root,"new.txt"),"new"); await writeFile(path.join(root,"private","auth.json"),"CHANGED SECRET");
    const baseline={sources:[{id:"claude",commit:"baseline"}],entries:[{source:"claude",path:"kept.txt",sha256:"old"},{source:"claude",path:"private/auth.json",sha256:null,disposition:"excluded",reason:"private-account-state"}]};
    const result=await captureSourceDrift({baseline,sources:[{id:"claude",root,symbolicRoot:"${MPX_PROJECTS}/mpx-claude-code"}]});
    expect(result.sources[0]).toMatchObject({id:"claude",dirty:true});
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({path:"kept.txt",state:"renamed",renamedTo:"renamed.txt"}),
      expect.objectContaining({path:"renamed.txt",state:"renamed",renamedFrom:"kept.txt"}),
      expect.objectContaining({path:"new.txt",state:"untracked"}),
      expect.objectContaining({path:"private/auth.json",privacy:"private-account-state",sha256:null}),
    ]));
    expect(JSON.stringify(result)).not.toContain("CHANGED SECRET");
  });

  it("reports every source disposition/evidence and fails the explicit exception gate",()=>{
    const baseline={entries:[{source:"claude",path:"a",destination:"content/a",disposition:"canonicalized",evidence:[{kind:"behavior-test",reference:"a.test"}]},{source:"pi",path:"b",destination:null,disposition:"retired",evidence:[]}]};
    const report=createParityReport({baseline,drift:{entries:[]},exceptions:[{id:"J-1",reason:"live proof pending"}]});
    expect(report.sourceEntries).toHaveLength(2);
    expect(report.parity.map(item=>item.category)).toEqual(["semantic","generation","hooks","tools","status","dependencies"]);
    expect(report.gate).toMatchObject({passed:false,exceptionCount:1});
  });

  it("audits old access read-only with hashed evidence and supports legacy-disabled acceptance",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"mpx-j-audit-")),oldPi=path.join("C:/","_MP_projects","mpx-pi"),oldClaude=path.join("C:/","_MP_projects","mpx-claude-code"); const log=path.join(root,"runtime.log"); await writeFile(log,`opened ${oldPi}/skills; token=secret`);
    const audit=await runtimeAccessAudit({roots:[root],processLines:[`node ${oldClaude}/bin.js --password nope`],environment:{MPX_PLUGIN_PATH:oldPi,API_TOKEN:"secret"},legacyDisabled:true});
    expect(audit.readOnly).toBe(true); expect(audit.findings.length).toBeGreaterThan(0); expect(audit.acceptance).toMatchObject({mode:"legacy-disabled",passed:false});
    expect(JSON.stringify(audit)).not.toContain("token=secret"); expect(JSON.stringify(audit)).not.toContain("password nope");
  });

  it("plans only exact owned removals behind the gate and restores an immutable rollback simulation",async()=>{
    const body="foreign\n# >>> old-mpx owned >>>\nlegacy\n# <<< old-mpx owned <<<\n";
    const plan=buildCutoverPlan({gatePassed:false,ownedActivations:[{path:"profile",startMarker:"# >>> old-mpx owned >>>",endMarker:"# <<< old-mpx owned <<<",content:body}]});
    expect(plan.actions[0]).toMatchObject({kind:"remove-owned-marker-block",eligible:false}); expect(plan.manualOnly.map(x=>x.kind)).toEqual(["archive","rename","remotes"]); expect(plan.confirmationDigest).toMatch(/^[a-f0-9]{64}$/);
    const drill=await rollbackDrill({content:body,startMarker:"# >>> old-mpx owned >>>",endMarker:"# <<< old-mpx owned <<<",now:new Date("2026-01-01T00:00:00Z")});
    expect(drill).toMatchObject({passed:true,snapshot:{immutable:true,retentionDays:30}});
    expect(drill.snapshot.digest).toBe(drill.restoredDigest);
  });
});
