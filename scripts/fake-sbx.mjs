#!/usr/bin/env node
import process from "node:process";
const argv=process.argv.slice(2);
const allowed=new Set(["version","create","policy","rm"]);
if(!allowed.has(argv[0])||argv.some(value=>/[\r\n\0]/u.test(value))){process.stderr.write('{"error":"FAKE_SBX_ARGV_INVALID"}\n');process.exitCode=2}
else process.stdout.write(`${JSON.stringify({schemaVersion:1,command:argv[0],argvSha256:(await import("node:crypto")).createHash("sha256").update(JSON.stringify(argv)).digest("hex"),status:"pass"})}\n`);
