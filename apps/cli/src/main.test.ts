import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MpxError, sha256Canonical, type JsonValue } from "@mpx/core";
import { PortService, RegistryStore, type PortPlatformAdapter, type WorktreeIdentity } from "@mpx/ports";
import { run } from "./main.js";
import { captureIo } from "./io.js";

const execFile = promisify(execFileCallback);

async function fixture(config:string):Promise<string>{
  const root=await mkdtemp(path.join(tmpdir(),"mpx-cli-"));
  await mkdir(path.join(root,".git")); await writeFile(path.join(root,"mpxconfig.json"),config);
  return root;
}
async function directory(prefix="mpx-cli-known-"):Promise<string>{
  return mkdtemp(path.join(tmpdir(),prefix));
}
const valid=JSON.stringify({schemaVersion:1,project:{id:"sample/app"},repository:{provider:"generic",remote:"origin"}});
const portPlatform:PortPlatformAdapter={holdAvailablePorts:async()=>({release:async()=>undefined}),inspectListeners:async()=>[],killProcess:async()=>undefined,inspectProcess:async()=>undefined};
function mainPortService(stateRoot:string,cwd:string,repositoryId:string):PortService{
  const identity:WorktreeIdentity={repositoryId,worktreeId:`${repositoryId}-main`,path:cwd,role:"main",commonGitPath:path.join(cwd,".git"),gitAdminPath:path.join(cwd,".git"),head:"abc"};
  return new PortService({store:new RegistryStore(stateRoot),git:{identify:async()=>identity,list:async()=>[identity]},platform:portPlatform});
}
const managed=(projectId:string,preferred=4173)=>JSON.stringify({schemaVersion:1,project:{id:projectId},repository:{provider:"generic",remote:"origin"},development:{services:{app:{scope:"checkout",port:{mode:"managed",preferred},start:{type:"package-script",script:"dev"}}}}});
async function launchEnv(cwd:string):Promise<NodeJS.ProcessEnv>{
  return configuredLaunchEnv(cwd);
}
async function configuredLaunchEnv(cwd:string, options:{classifiedRoot?:string;identityDomain?:string;extraDomains?:Record<string,string[]>;domains?:Record<string,string[]>;contentScopes?:Record<string,{roots:string[];skillPacks:string[]}>;docker?:boolean}={}):Promise<NodeJS.ProcessEnv>{
  const appdata=await mkdtemp(path.join(tmpdir(),"mpx-appdata-")); await mkdir(path.join(appdata,"mpx"));
  const classifiedRoot=options.classifiedRoot??cwd, identityDomain=options.identityDomain??"work";
  const domains=options.domains??{work:[classifiedRoot],...(options.extraDomains??{})};
  const contentScopes=options.contentScopes??{work:{roots:[classifiedRoot],skillPacks:["core"]}};
  await writeFile(path.join(appdata,"mpx","config.json"),JSON.stringify({
    identities:{work:{domain:identityDomain,runtimeRoots:{claude:"C:/native/claude-work",pi:"C:/native/pi-work"},gitAuthorRoute:"git-work",providerRoutes:{github:"github-work"}}},
    domains,
    contentScopes,
    modes:{
      project:{resources:{"selected-project":"read-write"}},
      developer:{resources:{"identity-domain":"read-write","cloned-repositories":"read-only"}},
      "personal-assistant":{resources:{"assistant-input":"read-write","assistant-output":"read-write"}},
      "computer-control":{resources:{"computer-control-config":"read-write","computer-control-executable-settings":"staged-write"}},
      unrestricted:{resources:{host:"read-write"}},
    },
    skillPolicies:{clean:{skillExposure:{default:"explicit-only"}},developer:{skillPacks:["core"],skillExposure:{default:"name-only"}}},
    presets:{"work-project":{identity:"work",mode:"project",skillPolicy:"clean",contentScope:"work",executor:"docker",workspace:"clone",networkPolicy:"implementation"}},
    launchDefaults:{projects:{"sample/app":{work:"work-project"}},scopes:{work:{work:"work-project"}}},
    networkPolicies:{implementation:{preset:"balanced"},minimal:{preset:"deny-all"}},
    executors:{host:{},...(options.docker===false?{}:{docker:{}})}
  }));
  return {APPDATA:appdata};
}

describe("cli",()=>{
  it("emits exactly one JSON document",async()=>{
    const cwd=await fixture(valid), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"config","validate"],io,{env:{}})).toBe(0);
    expect(io.err).toEqual([]); expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({apiVersion:1,ok:true,data:{valid:true}});
  });

  it("binds explicit --cwd into production worktree removal in-use detection",async()=>{
    const localAppData=await directory("mpx-cli-state-"), target=await directory("mpx-cli-target-"), inside=path.join(target,"packages","app"), io=captureIo(); await mkdir(inside,{recursive:true});
    let operationCwd="";
    const unavailable=async()=>{throw new Error("unexpected")};
    const portService={ensure:unavailable,resolve:unavailable,list:unavailable,inspect:unavailable,kill:unavailable,release:unavailable,reconcile:unavailable,rebuild:unavailable,captureReleaseIdentity:unavailable,releaseLinkedAfterRemoval:unavailable,resolveOrphan:unavailable} as never;
    const context={env:{LOCALAPPDATA:localAppData},portService,worktreeServiceFactory:(_root: string,_ports: unknown,cwd: string)=>{
      operationCwd=cwd;
      return {create:unavailable,list:unavailable,select:unavailable,status:unavailable,prepare:unavailable,cancel:unavailable,reconcile:unavailable,remove:async()=>{if(operationCwd.startsWith(target)) throw new MpxError({code:"WORKTREE_REMOVE_IN_USE",message:"in use"});return {status:"removed"}}} as never;
    }};
    expect(await run(["--json","--cwd",inside,"worktree","remove",target],io,context)).toBe(1);
    expect(operationCwd).toBe(path.resolve(inside));
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"WORKTREE_REMOVE_IN_USE"}});
  });

  it("init is a no-write plan",async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),"mpx-init-")), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"init"],io,{env:{}})).toBe(0);
    await expect(readFile(path.join(cwd,"mpxconfig.json"),"utf8")).rejects.toThrow();
    expect(JSON.parse(io.out[0]!).data.plan.actions[0].type).toBe("create");
  });

  it("confirmed init creates a valid suggested manifest before reserving the main worktree",async()=>{
    const cwd=await mkdtemp(path.join(tmpdir(),"mpx-init-create-")), stateRoot=await mkdtemp(path.join(tmpdir(),"mpx-init-create-state-")), io=captureIo();
    await mkdir(path.join(cwd,".git"));
    expect(await run(["--json","--cwd",cwd,"init","--confirm"],io,{env:{},portService:mainPortService(stateRoot,cwd,"created-repo")}),io.out.join("\n")).toBe(0);
    expect(JSON.parse(await readFile(path.join(cwd,"mpxconfig.json"),"utf8"))).toMatchObject({schemaVersion:1,project:{id:`REPLACE_ME/${path.basename(cwd)}`}});
    expect(JSON.parse(io.out[0]!).data.lease).toMatchObject({role:"main",slot:0});
  });

  it("confirmed init reserves slot zero and materializes the main projection",async()=>{
    const cwd=await fixture(managed("confirmed/app")), stateRoot=await mkdtemp(path.join(tmpdir(),"mpx-init-state-")), io=captureIo();
    const service=mainPortService(stateRoot,cwd,"confirmed-repo");
    expect(await run(["--json","--cwd",cwd,"init","--confirm"],io,{env:{},portService:service}),io.out.join("\n")).toBe(0);
    expect(JSON.parse(io.out[0]!).data.lease).toMatchObject({role:"main",slot:0,services:{app:4173}});
    expect(JSON.parse(await readFile(path.join(cwd,".worktree-ports.json"),"utf8"))).toMatchObject({schemaVersion:1,projectId:"confirmed/app",services:{app:4173}});
  });

  it("confirmed init rejects another project's exclusive preferred-port conflict",async()=>{
    const stateRoot=await mkdtemp(path.join(tmpdir(),"mpx-init-conflict-")), first=await fixture(managed("first/app")), second=await fixture(managed("second/app"));
    expect(await run(["--json","--cwd",first,"init","--confirm"],captureIo(),{env:{},portService:mainPortService(stateRoot,first,"repo-first")})).toBe(0);
    const io=captureIo();
    expect(await run(["--json","--cwd",second,"init","--confirm"],io,{env:{},portService:mainPortService(stateRoot,second,"repo-second")})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"PORT_CONFLICT"}});
    await expect(readFile(path.join(second,".worktree-ports.json"),"utf8")).rejects.toMatchObject({code:"ENOENT"});
  });

  it("repeated confirmed init leaves manifest, registry, and projection byte-identical",async()=>{
    const cwd=await fixture(managed("stable/app")), stateRoot=await mkdtemp(path.join(tmpdir(),"mpx-init-stable-")), service=mainPortService(stateRoot,cwd,"stable-repo");
    expect(await run(["--json","--cwd",cwd,"init","--confirm"],captureIo(),{env:{},portService:service})).toBe(0);
    const files=[path.join(cwd,"mpxconfig.json"),path.join(cwd,".worktree-ports.json"),path.join(stateRoot,"ports-registry.json")];
    const before=await Promise.all(files.map((file)=>readFile(file,"utf8")));
    expect(await run(["--json","--cwd",cwd,"init","--confirm"],captureIo(),{env:{},portService:service})).toBe(0);
    expect(await Promise.all(files.map((file)=>readFile(file,"utf8")))).toEqual(before);
  });

  it("normalizes malformed project config JSON to a privacy-safe CONFIG_INVALID envelope",async()=>{
    const cwd=await fixture('{"secret":"do-not-print",'), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"config","validate"],io,{env:{}})).toBe(1);
    const text=io.out.join(""), body=JSON.parse(text);
    expect(io.out).toHaveLength(1);
    expect(body).toMatchObject({apiVersion:1,ok:false,error:{code:"CONFIG_INVALID",message:"Configuration is invalid.",retryable:false},warnings:[]});
    expect(body.error.details).toBeUndefined();
    expect(text).not.toContain("do-not-print"); expect(text).not.toContain("Expected"); expect(text).not.toContain("position");
  });

  it("explains the selected provider by role",async()=>{
    const cwd=await fixture(JSON.stringify({schemaVersion:1,project:{id:"sample/app"},repository:{provider:"github",remote:"origin"},issues:{provider:"none"}})), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"provider","explain","repository"],io,{env:{}})).toBe(0);
    const data=JSON.parse(io.out[0]!).data;
    expect(data).toMatchObject({role:"repository",provider:"github",adapter:"gh"});
    expect(data.capabilities.every((capability:string)=>!capability.startsWith("issue."))).toBe(true);
  });

  it("uses exit two for usage errors",async()=>{
    const io=captureIo();
    expect(await run(["--json","unknown"],io,{env:{}})).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USAGE_ERROR"}});
  });

  it("fails skill commands closed when launch identity is omitted",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","list","--runtime","pi","--skill-policy","clean"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"IDENTITY_REQUIRED"}});
  });

  it("rejects skill resolution for an identity absent from strict user config",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","list","--runtime","pi","--identity","missing","--skill-policy","clean"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"IDENTITY_UNKNOWN"}});
  });

  it("requires an explicit runtime for every skill resolution",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","list","--identity","work","--skill-policy","clean"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"SKILL_RUNTIME_REQUIRED"}});
  });

  it("requires an explicit configured skill policy for every skill resolution",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","list","--identity","work","--runtime","pi"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"SKILL_POLICY_REQUIRED"}});
  });

  it("completes explicit-only skills for humans without descriptions",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","complete","/mpx:r","--identity","work","--runtime","pi","--skill-policy","clean"],io,{env,catalogRoot})).toBe(0);
    const text=io.out[0]!;
    expect(JSON.parse(text).data).toMatchObject({completions:["/mpx:review"]});
    expect(text).not.toContain("Reviews implementation");
  });

  it("constructs a launch-bound skill artifact from strict user-local inputs",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","list","--identity","work","--runtime","pi","--skill-policy","clean"],io,{env,catalogRoot})).toBe(0);
    const text=io.out[0]!, data=JSON.parse(text).data;
    expect(data).toMatchObject({artifact:{schemaVersion:3,identity:"work",skillPolicy:"clean",runtime:"pi",contentScope:"work"},skills:[{identity:"review",exposure:"explicit-only"}]});
    expect(data.artifact.effectivePolicyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(text).not.toContain("C:/native");
  });

  it("lists skills in a known non-project directory with a null projectId",async()=>{
    const cwd=await directory(), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","list","--identity","work","--runtime","pi","--skill-policy","clean"],io,{env,catalogRoot})).toBe(0);
    const data=JSON.parse(io.out[0]!).data;
    expect(data).toMatchObject({artifact:{identity:"work",contentScope:"work",runtime:"pi",projectId:null},skills:[{identity:"review",exposure:"explicit-only"}]});
  });

  it("binds the selected validated skill policy into artifact identity and disclosure",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    const cleanIo=captureIo(), developerIo=captureIo();
    expect(await run(["--json","--cwd",cwd,"skill","list","--identity","work","--runtime","pi","--skill-policy","clean"],cleanIo,{env,catalogRoot})).toBe(0);
    expect(await run(["--json","--cwd",cwd,"skill","list","--identity","work","--runtime","pi","--skill-policy","developer"],developerIo,{env,catalogRoot})).toBe(0);
    const clean=JSON.parse(cleanIo.out[0]!).data, developer=JSON.parse(developerIo.out[0]!).data;
    expect(clean.skills[0].exposure).toBe("explicit-only");
    expect(developer.skills[0].exposure).toBe("name-only");
    expect(clean.artifact.artifactKey).not.toBe(developer.artifact.artifactKey);
    expect(clean.artifact.effectivePolicyHash).not.toBe(developer.artifact.effectivePolicyHash);
  });

  it("constructs an identity-bound non-project skill artifact for a known cross-domain assistant cwd",async()=>{
    const cwd=await directory("mpx-assistant-input-"), workRoot=await directory("mpx-work-root-");
    const env=await configuredLaunchEnv(cwd,{domains:{work:[workRoot],"assistant-input":[cwd]},contentScopes:{work:{roots:[workRoot],skillPacks:["core"]},"assistant-input":{roots:[cwd],skillPacks:["core"]}}}), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","list","--identity","work","--runtime","pi","--skill-policy","clean"],io,{env,catalogRoot})).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toMatchObject({artifact:{identity:"work",contentScope:"assistant-input",runtime:"pi",projectId:null},skills:[{identity:"review",exposure:"explicit-only"}]});
  });

  it("surfaces invalid user-config interpolation as a sanitized CONFIG_INVALID envelope",async()=>{
    const appdata=await mkdtemp(path.join(tmpdir(),"mpx-appdata-")); await mkdir(path.join(appdata,"mpx"));
    await writeFile(path.join(appdata,"mpx","config.json"),JSON.stringify({identities:{},domains:{work:["${MPX_WORK}/nested"]},contentScopes:{},modes:{},skillPolicies:{},presets:{},executors:{host:{}}}));
    const io=captureIo();
    expect(await run(["--json","identity","list"],io,{env:{APPDATA:appdata,MPX_WORK:"C:/private/work"}})).toBe(1);
    const text=io.out[0]!;
    expect(JSON.parse(text)).toEqual({apiVersion:1,ok:false,error:{code:"CONFIG_INVALID",message:"Configuration is invalid.",retryable:false,details:{errors:[{pointer:"/domains/work/0",keyword:"semantic"}]}} ,warnings:[]});
    expect(text).not.toContain("private"); expect(text).not.toContain("MPX_WORK"); expect(text).not.toContain(appdata);
  });

  it("normalizes malformed user config JSON to a privacy-safe CONFIG_INVALID envelope",async()=>{
    const appdata=await mkdtemp(path.join(tmpdir(),"mpx-appdata-")); await mkdir(path.join(appdata,"mpx"));
    await writeFile(path.join(appdata,"mpx","config.json"),'{"secret":"do-not-print",');
    const io=captureIo();
    expect(await run(["--json","identity","list"],io,{env:{APPDATA:appdata}})).toBe(1);
    const text=io.out[0]!, body=JSON.parse(text);
    expect(body).toMatchObject({apiVersion:1,ok:false,error:{code:"CONFIG_INVALID",message:"Configuration is invalid.",retryable:false},warnings:[]});
    expect(body.error.details).toBeUndefined();
    expect(text).not.toContain("do-not-print"); expect(text).not.toContain("Expected"); expect(text).not.toContain("position");
  });

  it("fails optional user-config reads with USER_CONFIG_UNREADABLE instead of falling back to empty config",async()=>{
    const cwd=await fixture(valid), io=captureIo();
    const appdata=await mkdtemp(path.join(tmpdir(),"mpx-appdata-"));
    const accessFile=async()=>{throw Object.assign(new Error("denied"),{code:"EACCES"});};
    expect(await run(["--json","--cwd",cwd,"config","resolve"],io,{env:{APPDATA:appdata},accessFile})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USER_CONFIG_UNREADABLE",details:{errno:"EACCES"}}});
  });

  it("fails required user-config reads with USER_CONFIG_UNREADABLE instead of reporting missing config",async()=>{
    const io=captureIo();
    const appdata=await mkdtemp(path.join(tmpdir(),"mpx-appdata-"));
    const accessFile=async()=>{throw Object.assign(new Error("denied"),{code:"EPERM"});};
    expect(await run(["--json","identity","list"],io,{env:{APPDATA:appdata},accessFile})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USER_CONFIG_UNREADABLE",details:{errno:"EPERM"}}});
  });

  it("lists identities deterministically without native runtime roots",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    expect(await run(["--json","identity","list"],io,{env})).toBe(0);
    const text=io.out[0]!, body=JSON.parse(text);
    expect(body).toMatchObject({apiVersion:1,ok:true,data:{schemaVersion:1,kind:"identity",items:[{name:"work",domain:"work",gitAuthorRoute:"git-work",providerRoutes:{github:"github-work"}}]}});
    expect(text).not.toContain("runtimeRoots"); expect(text).not.toContain("C:/native");
  });

  it.each([
    ["mode","project"],
    ["skill-policy","clean"],
    ["preset","work-project"],
  ])("lists and shows read-only %s contracts in versioned envelopes",async(group,name)=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), listIo=captureIo(), showIo=captureIo();
    expect(await run(["--json",group,"list"],listIo,{env})).toBe(0);
    expect(await run(["--json",group,"show",name],showIo,{env})).toBe(0);
    expect(JSON.parse(listIo.out[0]!)).toMatchObject({apiVersion:1,ok:true,data:{schemaVersion:1,kind:group,items:expect.any(Array)}});
    expect(JSON.parse(showIo.out[0]!)).toMatchObject({apiVersion:1,ok:true,data:{schemaVersion:1,kind:group,item:{name}}});
  });

  it("explains candidates for every sorted identity without inferring one or exposing roots",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd);
    const file=path.join(env.APPDATA!,"mpx","config.json"), config=JSON.parse(await readFile(file,"utf8"));
    config.identities.alpha={...config.identities.work,runtimeRoots:{claude:"C:/native/alpha-claude",pi:"C:/native/alpha-pi"}};
    config.presets["alpha-project"]={...config.presets["work-project"],identity:"alpha"};
    config.launchDefaults.projects["sample/app"].alpha="alpha-project";
    config.launchDefaults.scopes.work.alpha="alpha-project";
    await writeFile(file,JSON.stringify(config));
    const io=captureIo();
    expect(await run(["--json","--cwd",cwd,"launch","explain"],io,{env})).toBe(0);
    const text=io.out[0]!, data=JSON.parse(text).data;
    expect(data).toMatchObject({schemaVersion:1,identity:null,runtime:null,candidates:[{identity:"alpha"},{identity:"work"}]});
    expect(text).not.toContain("runtimeRoots"); expect(text).not.toContain("C:/native"); expect(text).not.toContain(cwd);
  });

  it("accepts optional runtime and direct workspace/network axes in identity explanation",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    expect(await run(["--json","--cwd",cwd,"launch","explain","--identity","work","--workspace","host-worktree","--network-policy","minimal"],io,{env})).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toMatchObject({schemaVersion:1,runtime:null,identity:{name:"work",domain:"work"},selection:{workspace:"host-worktree",networkPolicy:{name:"minimal"},provenance:{workspace:"explicit",networkPolicy:"explicit"}}});
  });

  it("rejects the obsolete launch resolve surface",async()=>{
    const io=captureIo();
    expect(await run(["--json","launch","resolve","pi"],io,{env:{}})).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USAGE_ERROR"}});
  });

  it("resolves and inspects a launch without executing a harness",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--mode","project","--skill-policy","clean","--executor","docker"],io,{env,catalogRoot})).toBe(0);
    const text=io.out[0]!, body=JSON.parse(text);
    expect(io.err).toEqual([]); expect(io.out).toHaveLength(1);
    expect(body).toEqual({apiVersion:1,ok:true,data:expect.objectContaining({schemaVersion:1,runtime:"pi",identity:{name:"work",domain:"work"},mode:"project",skillPolicy:"clean",executor:expect.objectContaining({name:"docker",effectiveEnforcement:"mount-enforced"}),intendedPolicy:expect.objectContaining({resources:{"selected-project":"read-write"}}),skillArtifact:expect.objectContaining({artifactKey:expect.stringMatching(/^[a-f0-9]{64}$/),runtime:"pi",identity:"work",skillPolicy:"clean",contentScope:"work",projectId:"sample/app",catalogHash:expect.stringMatching(/^[a-f0-9]{64}$/),effectivePolicyHash:expect.stringMatching(/^[a-f0-9]{64}$/)})}),warnings:[]});
    expect(text).not.toContain("runtimeRoots"); expect(text).not.toContain("C:/native");
  });

  it("resolves launch inspection in a known ordinary non-project directory only when an explicit non-project mode is selected",async()=>{
    const cwd=await directory(), env=await configuredLaunchEnv(cwd), catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));

    const explicitIo=captureIo();
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--mode","developer","--skill-policy","clean","--executor","docker"],explicitIo,{env,catalogRoot})).toBe(0);
    expect(JSON.parse(explicitIo.out[0]!).data).toMatchObject({mode:"developer",skillArtifact:{projectId:null,identity:"work",contentScope:"work",runtime:"pi"}});

    const inferredIo=captureIo();
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--skill-policy","clean","--executor","docker"],inferredIo,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(inferredIo.out[0]!)).toMatchObject({ok:false,error:{code:"PROJECT_REQUIRED"}});
  });

  it("keeps assistant inferred non-project launch resolution successful without grants or project id",async()=>{
    const cwd=await directory("mpx-assistant-launch-");
    const env=await configuredLaunchEnv(cwd,{domains:{work:[await directory("mpx-work-root-")],"assistant-input":[cwd]},contentScopes:{work:{roots:[await directory("mpx-other-work-root-")],skillPacks:["core"]},"assistant-input":{roots:[cwd],skillPacks:["core"]}}});
    const io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--skill-policy","clean","--executor","docker"],io,{env,catalogRoot})).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toMatchObject({mode:"personal-assistant",skillArtifact:{projectId:null,contentScope:"assistant-input",runtime:"pi"}});
  });

  it("keeps oss inferred non-project launch resolution successful without grants or project id",async()=>{
    const cwd=await directory("mpx-oss-launch-");
    const env=await configuredLaunchEnv(cwd,{domains:{work:[await directory("mpx-work-root-")],oss:[cwd]},contentScopes:{work:{roots:[await directory("mpx-other-work-root-")],skillPacks:["core"]},"cloned-repositories":{roots:[cwd],skillPacks:["core"]}}});
    const io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--skill-policy","clean","--executor","docker"],io,{env,catalogRoot})).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toMatchObject({mode:"developer",skillArtifact:{projectId:null,contentScope:"cloned-repositories",runtime:"pi"}});
  });

  it("surfaces stable invalid-grant errors from launch inspection",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--mode","project","--skill-policy","clean","--grant","write:C:/work"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"GRANT_INVALID"}});
  });

  it("returns the full stable approval-required envelope for untrusted raw grants",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--mode","project","--skill-policy","clean","--grant","ro:work","--reason","Inspect project"],io,{env,catalogRoot})).toBe(1);
    expect(io.err).toEqual([]); expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toEqual({apiVersion:1,ok:false,error:{code:"GRANT_APPROVAL_REQUIRED",message:"Grant 'ro:work' requires a separate exact trusted approval with the launch reason.",retryable:false,remediation:"Confirm the grant through the trusted launch flow and relaunch."},warnings:[]});
  });

  it("surfaces a stable missing-elevation-reason error",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--mode","unrestricted","--skill-policy","clean"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"ELEVATION_REASON_REQUIRED"}});
  });

  it("surfaces a stable unavailable-executor error",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--mode","project","--skill-policy","clean","--executor","podman"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"EXECUTOR_UNAVAILABLE"}});
  });

  it("classifies a requested nested CWD rather than the discovered repository root",async()=>{
    const root=await fixture(valid), nested=path.join(root,"packages","app"); await mkdir(nested,{recursive:true});
    const env=await configuredLaunchEnv(root,{classifiedRoot:nested}), io=captureIo();
    expect(await run(["--json","--cwd",nested,"config","resolve"],io,{env})).toBe(0);
    expect(JSON.parse(io.out[0]!)).toMatchObject({apiVersion:1,ok:true,data:{cwdClassification:{status:"known",domain:"work"},contentScope:{name:"work",root:expect.any(String)}},warnings:[]});
  });

  it("surfaces a stable unknown-CWD error",async()=>{
    const cwd=await fixture(valid), other=await mkdtemp(path.join(tmpdir(),"mpx-known-")), env=await configuredLaunchEnv(cwd,{classifiedRoot:other}), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--runtime","pi","--identity","work","--mode","project","--skill-policy","clean"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"CWD_CLASSIFICATION_UNKNOWN"}});
  });

  it.each([
    ["full descriptor", ["--runtime","pi","--mode","project","--skill-policy","clean"]],
    ["optional-runtime identity explanation", []],
  ])("surfaces a stable identity-domain mismatch error for %s",async(_label,options)=>{
    const cwd=await fixture(valid), personal=await mkdtemp(path.join(tmpdir(),"mpx-personal-")), env=await configuredLaunchEnv(cwd,{identityDomain:"personal",extraDomains:{personal:[personal]}}), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","explain","--identity","work",...options],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"IDENTITY_DOMAIN_MISMATCH"}});
  });

  it("surfaces the first stable skill-catalog diagnostic message from runtime skill search",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"skill","search","review","--identity","work","--runtime","pi","--skill-policy","clean","--artifact-key","stale"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"STALE_ARTIFACT",message:"runtime search requires the current exact launch-bound artifact"}});
  });

  it("resolves runnable launch syntax before returning an actionable non-spawning Docker gate",async()=>{
    const cwd=await fixture(valid), env=await configuredLaunchEnv(cwd), io=captureIo();
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"launch","pi","--identity","work"],io,{env,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"LAUNCH_EXECUTION_DEFERRED",remediation:expect.stringContaining("Docker")}});
  });

  it("doctor reports a missing managed main reservation without allocating",async()=>{
    const config=JSON.stringify({schemaVersion:1,project:{id:"sample/app"},repository:{provider:"generic",remote:"origin"},development:{services:{app:{scope:"checkout",port:{mode:"managed",preferred:4173},start:{type:"package-script",script:"dev"}}}}});
    const cwd=await fixture(config), env=await launchEnv(cwd), io=captureIo(); let ensured=false; let doctorRequest: {config: unknown; configHash: string}|undefined;
    const portService={resolve:async(request:{config:unknown;configHash:string})=>{doctorRequest=request;throw new MpxError({code:"PORT_LEASE_INVALID",message:"missing"});},ensure:async()=>{ensured=true;}} as never;
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"doctor"],io,{env,portService,catalogRoot})).toBe(1);
    expect(JSON.parse(io.out[0]!).data.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:"PORT_LEASE_INVALID",severity:"error"})]));
    expect(ensured).toBe(false); expect(doctorRequest!.configHash).toBe(sha256Canonical(doctorRequest!.config as JsonValue));
  });

  it("doctor warns deterministically for fixed-shared services without requiring a reservation",async()=>{
    const config=JSON.stringify({schemaVersion:1,project:{id:"sample/app"},repository:{provider:"generic",remote:"origin"},development:{services:{app:{scope:"checkout",port:{mode:"fixed-shared",preferred:4173},start:{type:"package-script",script:"dev"}}}}});
    const cwd=await fixture(config), env=await launchEnv(cwd), io=captureIo(); let resolved=false;
    const catalogRoot=fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog",import.meta.url));
    expect(await run(["--json","--cwd",cwd,"doctor"],io,{env,portService:{resolve:async()=>{resolved=true;}} as never,catalogRoot})).toBe(0);
    expect(io.out).toHaveLength(1); expect(JSON.parse(io.out[0]!).data.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:"FIXED_SHARED_LIMITATION",severity:"warning"})])); expect(resolved).toBe(false);
  });

  it("reports unavailable default state roots without touching user state",async()=>{
    const io=captureIo();
    expect(await run(["--json","ports","list"],io,{env:{}})).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"STATE_ROOT_UNAVAILABLE"}});
  });

  it("sorts injected global leases and emits one envelope",async()=>{
    const io=captureIo();
    const leases=[{leaseId:"z"},{leaseId:"a"}] as never[];
    const portService={list:async()=>leases} as never;
    expect(await run(["--json","ports","list"],io,{env:{},portService})).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!).data.map((lease:{leaseId:string})=>lease.leaseId)).toEqual(["a","z"]);
  });

  it("delegates every read/write ports command with one envelope",async()=>{
    const cwd=await fixture(valid), calls:string[]=[], requests:unknown[]=[];
    const lease={leaseId:"lease",projectId:"sample/app",worktreeId:"worktree",configHash:"hash",services:{app:4173}};
    const portService={
      ensure:async(request:unknown)=>{calls.push("ensure");requests.push(request);return {lease,warnings:[{code:"FIXED_SHARED_DUPLICATE",message:"shared",port:4173}]};},
      resolve:async(request:unknown)=>{calls.push("resolve");requests.push(request);return lease;},
      inspect:async()=>{calls.push("inspect");return [];},
      release:async()=>{calls.push("release");},
      reconcile:async()=>{calls.push("reconcile");return {removed:[],repaired:[]};},
    } as never;
    for(const action of ["ensure","resolve","inspect","release","reconcile"]){
      const io=captureIo();
      expect(await run(["--json","--cwd",cwd,"ports",action],io,{env:{},portService})).toBe(0);
      expect(io.out).toHaveLength(1);
      expect(JSON.parse(io.out[0]!)).toMatchObject({apiVersion:1,ok:true});
    }
    expect(calls).toEqual(["ensure","resolve","inspect","release","reconcile"]);
    const discovered=JSON.parse(valid); for(const value of requests){const request=value as {config:unknown;configHash:string}; expect(request.config).toEqual(discovered); expect(request.configHash).toBe(sha256Canonical(discovered as JsonValue));}
    const changed={...discovered,repository:{...discovered.repository,remote:"changed"}}; expect(sha256Canonical(changed as JsonValue)).not.toBe(sha256Canonical(discovered as JsonValue));
  });

  it("delegates strict ports rebuild with known roots in one envelope",async()=>{
    const cwd=await fixture(valid), known=await mkdtemp(path.join(tmpdir(),"mpx-known-"));
    const env=await configuredLaunchEnv(cwd,{extraDomains:{personal:[known]}});
    let request:{roots:string[]}|undefined; const portService={rebuild:async(value:{roots:string[]})=>{request=value;return {discovered:1,rebuilt:1,roots:2}}} as never; const io=captureIo();
    expect(await run(["--json","--cwd",cwd,"ports","reconcile","--rebuild"],io,{env,portService})).toBe(0);
    expect(request!.roots).toEqual([path.resolve(cwd),path.resolve(known)]);
    expect(io.out).toHaveLength(1); expect(JSON.parse(io.out[0]!)).toMatchObject({ok:true,data:{discovered:1,rebuilt:1,roots:2}});
  });

  it("rejects --rebuild on other ports commands as usage",async()=>{
    const io=captureIo();
    expect(await run(["--json","ports","list","--rebuild"],io,{env:{},portService:{list:async()=>[]} as never})).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USAGE_ERROR"}});
  });

  it("passes the full canonical config hash to status and changes it when config changes",async()=>{
    const cwd=await fixture(valid), requests:Array<{config:unknown;configHash:string}>=[];
    const statusProvider={snapshot:async(request:{config:unknown;configHash:string})=>{requests.push(request);return {schemaVersion:1,project:{id:"sample",cwd},worktree:{id:null,path:null,role:null,branch:null},portResolution:"missing",services:[],diagnostics:[]};}} as never;
    expect(await run(["--json","--cwd",cwd,"status"],captureIo(),{env:{},statusProvider})).toBe(0);
    const changed={...JSON.parse(valid),repository:{provider:"generic",remote:"changed"}}; await writeFile(path.join(cwd,"mpxconfig.json"),JSON.stringify(changed));
    expect(await run(["--json","--cwd",cwd,"status"],captureIo(),{env:{},statusProvider})).toBe(0);
    expect(requests[0]!.configHash).toBe(sha256Canonical(requests[0]!.config as JsonValue)); expect(requests[1]!.configHash).toBe(sha256Canonical(requests[1]!.config as JsonValue)); expect(requests[1]!.configHash).not.toBe(requests[0]!.configHash);
  });

  it("places fixed-shared diagnostics in envelope warnings",async()=>{
    const cwd=await fixture(valid), io=captureIo();
    const portService={ensure:async()=>({lease:{leaseId:"lease"},warnings:[{code:"FIXED_SHARED_DUPLICATE",message:"shared",port:4173}]})} as never;
    expect(await run(["--json","--cwd",cwd,"ports","ensure"],io,{env:{},portService})).toBe(0);
    expect(JSON.parse(io.out[0]!).warnings).toEqual([expect.objectContaining({code:"FIXED_SHARED_DUPLICATE",severity:"warning"})]);
  });

  it.each(["list","inspect"])("rejects extra arguments for ports %s",async(action)=>{
    const io=captureIo(), portService={list:async()=>[],inspect:async()=>[]} as never;
    expect(await run(["--json","ports",action,"extra"],io,{env:{},portService})).toBe(2);
  });

  it("delegates the complete worktree CLI surface through injected dependencies",async()=>{
    const cwd=await fixture(valid), calls:Array<[string,unknown]>=[];
    const worktreeService={
      create:async(request:unknown)=>{calls.push(["create",request]);return {schemaVersion:1,owner:"mpx",operation:"create",status:"ready",worktreePath:"C:/repo.worktrees/feature/x"};},
      remove:async(request:unknown)=>{calls.push(["remove",request]);return {schemaVersion:1,owner:"mpx",operation:"remove",status:"removed"};},
      list:async(request:unknown)=>{calls.push(["list",request]);return [{path:"C:/repo",branch:"main"}]},
      status:async(request:unknown)=>{calls.push(["status",request]);return {schemaVersion:1,owner:"mpx",operation:"status",status:"ok"};},
      prepare:async(request:unknown)=>{calls.push(["prepare",request]);return {schemaVersion:1,status:"ready"};},
      cancel:async(request:unknown)=>{calls.push(["cancel",request]);return {schemaVersion:1,status:"cancelled"};},
      reconcile:async(request:unknown)=>{calls.push(["reconcile",request]);return {schemaVersion:1,owner:"mpx",operation:"reconcile",status:"reconciled",orphaned:[]};},
      select:async(request:unknown)=>{calls.push(["select",request]);return {path:"C:/repo.worktrees/feature/x",branch:"feature/x"};},
    } as never;
    const commands=[
      ["create","feature/x","--base","origin/main","--template","{slug}","--slug","feature x","--execution","foreground"],
      ["remove","C:/repo.worktrees/feature/x"], ["list"], ["status"], ["prepare","feature/x","--package-approval","APPROVE PACKAGE","--explicit-executable-approval","APPROVE EXPLICIT"],
      ["cancel","feature/x"], ["reconcile","--orphan-approval","RESOLVE ORPHAN abc"],
    ];
    for(const command of commands){const io=captureIo();expect(await run(["--json","--cwd",cwd,"worktree",...command],io,{env:{},worktreeService})).toBe(0);expect(io.out).toHaveLength(1);expect(JSON.parse(io.out[0]!)).toMatchObject({apiVersion:1,ok:true});}
    expect(calls.map(([name])=>name)).toEqual(["create","remove","list","status","prepare","cancel","reconcile"]);
    expect(calls[0]![1]).toMatchObject({cwd,branch:"feature/x",base:"origin/main",template:"{slug}",slug:"feature x",execution:"foreground"});
    expect(calls[4]![1]).toMatchObject({ approval: JSON.stringify({ packageAutomationApproval: "APPROVE PACKAGE", explicitExecutableApproval: "APPROVE EXPLICIT" }) });
  });

  it("ships source-only Bash and PowerShell cd wrappers without invoking them on load",async()=>{
    const root=fileURLToPath(new URL("../../..",import.meta.url));
    const bash=await readFile(path.join(root,"scripts","mpx-worktree.bash"),"utf8");
    const powershell=await readFile(path.join(root,"scripts","mpx-worktree.ps1"),"utf8");
    expect(bash).toContain("mpx worktree select --machine"); expect(bash).toContain("cd --");
    expect(powershell).toContain("mpx worktree select --machine"); expect(powershell).toContain("Set-Location -LiteralPath");

    const wrapperRoot=await mkdtemp(path.join(tmpdir(),"mpx wrapper-"));
    const bashPath=path.join(wrapperRoot,"mpx-worktree.bash"), powershellPath=path.join(wrapperRoot,"mpx-worktree.ps1");
    await writeFile(bashPath,bash); await writeFile(powershellPath,powershell);
    await execFile("bash",["-n",bashPath]);
    await execFile("bash",["-c",'set -e; before=$PWD; . "$1"; test "$PWD" = "$before"',"mpx-wrapper-load",bashPath]);

    if(process.platform === "win32"){
      const parserLoader=path.join(wrapperRoot,"load-wrapper.ps1");
      await writeFile(parserLoader,`param([Parameter(Mandatory)][string]$WrapperPath)
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($WrapperPath, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
$before = (Get-Location).Path
. $WrapperPath
if ((Get-Location).Path -ne $before) { throw "location changed" }
`);
      await execFile("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-File",parserLoader,powershellPath]);
    }
  });

  it("prints exactly one selected path in machine mode and no path on cancellation",async()=>{
    const selected=captureIo();
    expect(await run(["worktree","select","--machine","--path","C:/repo worktrees/x"],selected,{env:{},worktreeService:{select:async()=>({path:"C:/repo worktrees/x"})} as never})).toBe(0);
    expect(selected.out).toEqual(["C:/repo worktrees/x\n"]); expect(selected.err).toEqual([]);
    const cancelled=captureIo();
    expect(await run(["worktree","select","--machine","--cancel"],cancelled,{env:{},worktreeService:{select:async()=>{throw new Error("must not run")}} as never})).toBe(0);
    expect(cancelled.out).toEqual([]); expect(cancelled.err).toEqual([]);
  });

  it.each(["yes","force","delete-branch","trust"]) ("rejects unsafe worktree bypass --%s",async(option)=>{
    const io=captureIo();
    expect(await run(["--json","worktree","remove","x",`--${option}`],io,{env:{},worktreeService:{} as never})).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USAGE_ERROR"}});
  });

  it("routes a validated positional PID through PortService.kill",async()=>{
    const io=captureIo(); let killed:number|undefined;
    const portService={kill:async(pid:number)=>{killed=pid}} as never;
    expect(await run(["--json","ports","kill","42"],io,{env:{},portService})).toBe(0);
    expect(killed).toBe(42);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:true,data:{killed:true,pid:42},warnings:[]});
  });

  it("rejects ambiguous PID syntax",async()=>{
    const io=captureIo(); const portService={kill:async()=>undefined} as never;
    expect(await run(["--json","ports","kill","42","--pid","42"],io,{env:{},portService})).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ok:false,error:{code:"USAGE_ERROR"}});
  });
});
