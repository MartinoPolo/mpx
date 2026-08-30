import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { commandSelectorBytes } from './windows-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'bin');
const evidence = path.join(root, 'evidence');
await Promise.all([mkdir(output, { recursive: true }), mkdir(evidence, { recursive: true })]);
await Promise.all([
  copyFile(
    path.join(root, 'docs', 'inventory', 'SBX_V0_39_0.json'),
    path.join(evidence, 'sbx-pin.json'),
  ),
  copyFile(
    path.join(root, 'docs', 'inventory', 'PHASE_F1_RUNTIME_TOOL_INVENTORY.json'),
    path.join(evidence, 'runtime-tool-inventory.json'),
  ),
  copyFile(
    path.join(root, 'packages', 'executors', 'src', 'index.ts'),
    path.join(evidence, 'executor-evidence.ts'),
  ),
]);
await build({
  entryPoints: [path.join(root, 'apps', 'cli', 'dist', 'main.js')],
  outfile: path.join(output, 'mpx.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  plugins: [
    {
      name: 'inline-config-schemas',
      setup(buildApi) {
        buildApi.onLoad(
          { filter: /packages[\\/]config[\\/]dist[\\/]schema\.js$/ },
          async (args) => {
            const source = await readFile(args.path, 'utf8');
            const schemas = path.join(root, 'packages', 'config', 'schemas');
            const project = JSON.stringify(
              JSON.parse(await readFile(path.join(schemas, 'mpxconfig.schema.json'), 'utf8')),
            );
            const user = JSON.stringify(
              JSON.parse(await readFile(path.join(schemas, 'user-config.schema.json'), 'utf8')),
            );
            const readFileSyncImportPattern =
              /^import \{ readFileSync \} from ['"]node:fs['"];\r?\n/mu;
            const loadFunctionPattern = /function load\(name\)\s*\{[\s\S]*?\n\}/u;
            const withoutReadFileSyncImport = source.replace(readFileSyncImportPattern, '');
            if (withoutReadFileSyncImport === source) {
              throw new Error(`Expected readFileSync import in ${args.path}`);
            }
            const contents = withoutReadFileSyncImport.replace(
              loadFunctionPattern,
              `function load(name) {
                if (name === "mpxconfig.schema.json") {
                  return ${project};
                }
                if (name === "user-config.schema.json") {
                  return ${user};
                }
                throw new Error('Unknown bundled config schema: ' + name);
              }`,
            );
            if (contents === withoutReadFileSyncImport) {
              throw new Error(`Expected load(name) function in ${args.path}`);
            }
            return {
              loader: 'js',
              contents,
            };
          },
        );
      },
    },
  ],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  banner: {
    js: 'import { createRequire as __mpxCreateRequire } from "node:module"; const require = __mpxCreateRequire(import.meta.url);',
  },
});
await writeFile(path.join(output, 'mpx.cmd'), commandSelectorBytes());
