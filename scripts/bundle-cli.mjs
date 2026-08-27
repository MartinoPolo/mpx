import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "bin");
const evidence = path.join(root, "evidence");
await Promise.all([mkdir(output, { recursive: true }), mkdir(evidence, { recursive: true })]);
await Promise.all([
  copyFile(path.join(root, "docs", "inventory", "SBX_V0_39_0.json"), path.join(evidence, "sbx-pin.json")),
  copyFile(path.join(root, "docs", "inventory", "PHASE_F1_RUNTIME_TOOL_INVENTORY.json"), path.join(evidence, "runtime-tool-inventory.json")),
  copyFile(path.join(root, "packages", "executors", "src", "index.ts"), path.join(evidence, "executor-evidence.ts")),
]);
await build({
  entryPoints: [path.join(root, "apps", "cli", "dist", "main.js")],
  outfile: path.join(output, "mpx.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  plugins: [{ name: "inline-config-schemas", setup(buildApi) {
    buildApi.onLoad({ filter: /packages[\\/]config[\\/]dist[\\/]schema\.js$/ }, async args => {
      const source = await readFile(args.path, "utf8");
      const schemas = path.join(root, "packages", "config", "schemas");
      const project = JSON.stringify(JSON.parse(await readFile(path.join(schemas, "mpxconfig.schema.json"), "utf8")));
      const user = JSON.stringify(JSON.parse(await readFile(path.join(schemas, "user-config.schema.json"), "utf8")));
      return { loader: "js", contents: source
        .replace('import { readFileSync } from "node:fs";\n', "")
        .replace('function load(name) { return JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8")); }', `function load(name) { return name === "mpxconfig.schema.json" ? ${project} : ${user}; }`) };
    });
  } }],
  sourcemap: false,
  minify: true,
  legalComments: "none",
  banner: { js: 'import { createRequire as __mpxCreateRequire } from "node:module"; const require = __mpxCreateRequire(import.meta.url);' },
});
const selector = String.raw`@echo off
setlocal
if not defined LOCALAPPDATA exit /b 2
if not defined MPX_APPS exit /b 2
if not defined MPX_NODE_EXECUTABLE exit /b 2
set /p "MPX_RELEASE_KEY="<"%LOCALAPPDATA%\mpx\active-release"
if not defined MPX_RELEASE_KEY exit /b 2
"%MPX_NODE_EXECUTABLE%" "%MPX_APPS%\mpx\releases\%MPX_RELEASE_KEY%\bin\mpx.mjs" %*
exit /b %ERRORLEVEL%
`;
await writeFile(path.join(output, "mpx.cmd"), selector, "utf8");
