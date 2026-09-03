import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const productionBundles = new Map<string, Promise<string>>();

export async function bundledSource(entry: string, label: string): Promise<string> {
  let pending = productionBundles.get(entry);
  if (!pending) {
    pending = bundle({
      absWorkingDir: packageRoot,
      entryPoints: [path.join(packageRoot, 'src', entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      write: false,
      legalComments: 'none',
      sourcemap: false,
    }).then((result) => {
      const output = result.outputFiles[0];
      if (!output) {
        throw new Error(`Pi ${label} bundle was not emitted`);
      }
      return output.text;
    });
    productionBundles.set(entry, pending);
  }
  return pending;
}
