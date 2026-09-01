import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { commandSelectorBytes } from './windows-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'bin');
const evidence = path.join(root, 'evidence');

async function workspaceSourceMap() {
  const directories = ['apps', 'packages', 'runtimes'];
  const manifests = [];
  for (const top of directories) {
    const entries = await readdir(path.join(root, top), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'package.json') {
        const file = path.join(entry.parentPath, entry.name);
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        if (typeof manifest.name === 'string') {
          manifests.push([manifest.name, path.dirname(file), manifest]);
        }
      }
    }
  }
  return new Map(manifests.map(([name, directory, manifest]) => [name, { directory, manifest }]));
}

function exportedTarget(exportsValue, subpath) {
  const selected =
    typeof exportsValue === 'string'
      ? subpath === '.'
        ? exportsValue
        : undefined
      : (exportsValue?.[subpath] ??
        (subpath === '.' && (exportsValue?.default || exportsValue?.import)
          ? exportsValue
          : undefined));
  return typeof selected === 'string' ? selected : (selected?.default ?? selected?.import);
}

async function sourceWorkspaceExports() {
  const workspaces = await workspaceSourceMap();
  return {
    name: 'source-workspace-exports',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@mpx\// }, (args) => {
        const segments = args.path.split('/');
        const packageName = segments.slice(0, 2).join('/');
        const workspace = workspaces.get(packageName);
        if (!workspace) {
          return undefined;
        }
        const subpath = segments.length === 2 ? '.' : `./${segments.slice(2).join('/')}`;
        const target = exportedTarget(workspace.manifest.exports, subpath);
        if (!target) {
          throw new Error(`Undeclared workspace export: ${args.path}`);
        }
        const sourceRelative = target.replace(/^\.\/dist\//u, './src/').replace(/\.js$/u, '.ts');
        return { path: path.resolve(workspace.directory, sourceRelative) };
      });
    },
  };
}

const inlineConfigSchemas = {
  name: 'inline-config-schemas',
  setup(buildApi) {
    buildApi.onLoad(
      { filter: /packages[\\/]config[\\/](?:src|dist)[\\/]schema\.(?:ts|js)$/ },
      async (args) => {
        const source = await readFile(args.path, 'utf8');
        const schemas = path.join(root, 'packages', 'config', 'schemas');
        const project = JSON.stringify(
          JSON.parse(await readFile(path.join(schemas, 'mpxconfig.schema.json'), 'utf8')),
        );
        const user = JSON.stringify(
          JSON.parse(await readFile(path.join(schemas, 'user-config.schema.json'), 'utf8')),
        );
        const withoutImport = source.replace(
          /^import \{ readFileSync \} from ['"]node:fs['"];\r?\n/mu,
          '',
        );
        if (withoutImport === source) {
          throw new Error(`Expected readFileSync import in ${args.path}`);
        }
        const contents = withoutImport.replace(
          /function load\(name(?:: string)?\)(?:: object)?\s*\{[\s\S]*?\n\}/u,
          `function load(name) {
        if (name === "mpxconfig.schema.json") return ${project};
        if (name === "user-config.schema.json") return ${user};
        throw new Error('Unknown bundled config schema: ' + name);
      }`,
        );
        if (contents === withoutImport) {
          throw new Error(`Expected load(name) function in ${args.path}`);
        }
        return { loader: args.path.endsWith('.ts') ? 'ts' : 'js', contents };
      },
    );
  },
};

const bundleOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  banner: {
    js: 'import { createRequire as __mpxCreateRequire } from "node:module"; const require = __mpxCreateRequire(import.meta.url);',
  },
};

function sourceOverridePlugin(sourceOverrides) {
  const overrides = new Map(
    [...sourceOverrides].map(([name, bytes]) => [
      path.resolve(root, name),
      Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    ]),
  );
  return {
    name: 'isolated-source-overrides',
    setup(buildApi) {
      buildApi.onLoad({ filter: /.*/ }, (args) => {
        const contents = overrides.get(path.resolve(args.path));
        if (contents === undefined) {
          return undefined;
        }
        const extension = path.extname(args.path).slice(1);
        const loader = ['ts', 'tsx', 'js', 'jsx', 'json'].includes(extension) ? extension : 'text';
        return { contents, loader };
      });
    },
  };
}

async function canonicalSourceDigest(sourceOverrides) {
  const hash = createHash('sha256');
  const names = [];
  for (const top of ['apps', 'packages', 'runtimes']) {
    const entries = await readdir(path.join(root, top), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const name = path.join(entry.parentPath, entry.name);
      const portable = name.replaceAll('\\', '/');
      if (
        entry.isFile() &&
        ((portable.includes('/src/') && /\.[cm]?tsx?$/u.test(entry.name)) ||
          entry.name.endsWith('.schema.json'))
      ) {
        names.push(name);
      }
    }
  }
  for (const name of names.sort()) {
    const relative = path.relative(root, name).replaceAll('\\', '/');
    hash
      .update(relative)
      .update('\0')
      .update(sourceOverrides.get(relative) ?? (await readFile(name)))
      .update('\0');
  }
  return hash.digest('hex');
}

export async function buildBundleBytes(options = {}) {
  const sourceOverrides = options.sourceOverrides ?? new Map();
  const workspacePlugin = await sourceWorkspaceExports();
  const sourceDigest = await canonicalSourceDigest(sourceOverrides);
  const entries = [
    ['bin/mpx.mjs', path.join(root, 'apps', 'cli', 'src', 'main.ts')],
    [
      'bin/claude-gateway.js',
      path.join(root, 'packages', 'application', 'src', 'node', 'claude-gateway.ts'),
    ],
  ];
  return new Map(
    await Promise.all(
      entries.map(async ([name, entryPoint]) => {
        const result = await build({
          ...bundleOptions,
          banner: {
            js: `${bundleOptions.banner.js} /* canonical-source-sha256:${sourceDigest} */`,
          },
          plugins: [sourceOverridePlugin(sourceOverrides), workspacePlugin, inlineConfigSchemas],
          entryPoints: [entryPoint],
          write: false,
        });
        if (result.outputFiles.length !== 1) {
          throw new Error(`Expected one bundle output for ${name}`);
        }
        return [name, Buffer.from(result.outputFiles[0].contents)];
      }),
    ),
  );
}

export async function checkBundles(options = {}) {
  const expected = await buildBundleBytes({ sourceOverrides: options.sourceOverrides });
  const readTrackedBundle =
    options.readTrackedBundle ?? ((name) => readFile(path.join(root, name)));
  const diagnostics = [];
  for (const [name, bytes] of expected) {
    try {
      const actual = await readTrackedBundle(name);
      if (!actual.equals(bytes)) {
        diagnostics.push(
          `BUNDLE_DRIFT: ${name}: tracked bundle differs from canonical source build`,
        );
      }
    } catch (failure) {
      if (failure?.code === 'ENOENT') {
        diagnostics.push(`BUNDLE_MISSING: ${name}: tracked bundle is missing`);
      } else {
        throw failure;
      }
    }
  }
  return diagnostics;
}

async function writeBundles() {
  const bundles = await buildBundleBytes();
  await Promise.all([mkdir(output, { recursive: true }), mkdir(evidence, { recursive: true })]);
  await Promise.all([...bundles].map(([name, bytes]) => writeFile(path.join(root, name), bytes)));
  await writeFile(path.join(output, 'mpx.cmd'), commandSelectorBytes());
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const diagnostics = await checkBundles();
    if (diagnostics.length) {
      diagnostics.forEach((item) => console.error(item));
      process.exitCode = 1;
    } else {
      console.log('Tracked CLI bundles match canonical source builds.');
    }
  } else {
    await writeBundles();
  }
}
