import { expect, it } from "vitest";
import { createRuntimeContextV1 } from "@mpx/runtime-contracts";
import { planPiInvocation } from "../src/index.js";

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
