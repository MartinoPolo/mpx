import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const action = process.argv[2];

function run(modulePath, args) {
  const result = spawnSync(process.execPath, [require.resolve(modulePath), ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

switch (action) {
  case "build":
    run("typescript/bin/tsc", ["-p", "tsconfig.json"]);
    break;
  case "test":
    run("vitest/vitest.mjs", ["run"]);
    break;
  case "typecheck":
    run("typescript/bin/tsc", ["-p", "tsconfig.json", "--noEmit"]);
    run("typescript/bin/tsc", ["-p", "tsconfig.test.json"]);
    break;
  default:
    throw new Error(`Unknown package script action: ${String(action)}`);
}
