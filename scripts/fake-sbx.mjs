#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";
const argv=process.argv.slice(2);
const scoped=argv[0]==="--app-name";
const appName=scoped?argv[1]:undefined;
const command=argv[scoped?2:0];
const allowed=new Set(["version","--help","daemon","diagnose","create","run","exec","ports","policy","ls","rm"]);
if(!allowed.has(command)||(scoped&&!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(appName??""))||argv.some(value=>/[\r\n\0]/u.test(value))){process.stderr.write('{"error":"FAKE_SBX_ARGV_INVALID"}\n');process.exitCode=2;}
else if(command==="version")process.stdout.write("sbx version: v0.39.0 def8cb0523a77e757bdd6ef52b459fe374f3783e\n");
else if(command==="--help")process.stdout.write(["create","daemon","diagnose","exec","ls","policy","ports","rm","run","version"].map(value=>`  ${value} fake`).join("\n")+"\n");
else if(command==="daemon")process.stdout.write('{"status":"running","socket":"fake","clientVersion":"0.39.0","daemonVersion":"0.39.0"}\n');
else if(command==="diagnose")process.stdout.write('{"version":"1.0","checks":[{"name":"Authentication","status":"pass","message":"fake","detail":"fake","hint":"fake"}],"summary":{"pass":1,"warn":0,"fail":0,"skip":0}}\n');
else process.stdout.write(`${JSON.stringify({schemaVersion:1,command,argvSha256:createHash("sha256").update(JSON.stringify(argv)).digest("hex"),status:"pass"})}\n`);
