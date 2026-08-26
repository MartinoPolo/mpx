import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureIo } from "./io.js";
import { run } from "./main.js";

it("runs local create/show/update/close and dependency commands without an identity route", async () => {
  const cwd=await mkdtemp(path.join(tmpdir(),"mpx-local-cli-"));await mkdir(path.join(cwd,".git"));
  await writeFile(path.join(cwd,"mpxconfig.json"),JSON.stringify({schemaVersion:1,project:{id:"acme/app"},repository:{provider:"generic",remote:"origin"},issues:{provider:"local",root:"issues"}}));
  const command=async(args:string[])=>{const io=captureIo();expect(await run(["--json","--cwd",cwd,...args],io,{env:{}}),io.out.join("\n")).toBe(0);return JSON.parse(io.out[0]!).data;};
  expect(await command(["issue","create","--title","A","--body","B"])).toMatchObject({id:"1"});
  await command(["issue","create","--title","Dependency","--body",""]);
  expect(await command(["issue","dependency","add","--id","1","--dependency-id","2"])).toMatchObject({id:"1"});
  expect(await command(["issue","show","--id","1"])).toMatchObject({providerData:{local:{dependencies:{frontier:["2"]}}}});
  expect(await command(["issue","update","--id","1","--title","Updated","--body","Body"])).toMatchObject({title:"Updated"});
  expect(await command(["issue","close","--id","1"])).toMatchObject({state:"finished"});
});
