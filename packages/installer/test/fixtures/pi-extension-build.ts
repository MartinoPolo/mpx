import { cp, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function preparePiExtensionBuildFixture(
  checkoutRoot: string,
  repositoryRoot: string,
  importKey: string,
): Promise<() => Promise<void>> {
  const sourceExtensionRoot = path.join(checkoutRoot, 'runtimes', 'pi', 'extensions');
  const extensionRoot = path.join(repositoryRoot, 'runtimes', 'pi', 'extensions');
  await mkdir(path.dirname(extensionRoot), { recursive: true });
  await cp(path.join(checkoutRoot, 'tsconfig.json'), path.join(repositoryRoot, 'tsconfig.json'));
  await cp(sourceExtensionRoot, extensionRoot, {
    recursive: true,
    filter: (source) => !['dist', 'node_modules'].includes(path.basename(source)),
  });

  const configDependencyRoot = path.dirname(
    path.dirname(
      await realpath(path.join(checkoutRoot, 'packages', 'config', 'node_modules', 'ajv')),
    ),
  );
  for (const [dependency, sourceRoot] of [
    ['ajv', configDependencyRoot],
    ['fast-deep-equal', configDependencyRoot],
    ['fast-uri', configDependencyRoot],
    ['json-schema-traverse', configDependencyRoot],
    ['require-from-string', configDependencyRoot],
    ['croner', sourceExtensionRoot],
    ['nanoid', sourceExtensionRoot],
  ] as const) {
    await cp(
      path.join(sourceRoot, 'node_modules', dependency),
      path.join(extensionRoot, 'node_modules', dependency),
      { recursive: true, dereference: true },
    );
  }

  for (const dependency of [
    'config',
    'content-compiler',
    'core',
    'runtime-contracts',
    'skills',
    'subagents',
  ]) {
    const destination = path.join(extensionRoot, 'node_modules', '@mpx', dependency);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(checkoutRoot, 'packages', dependency), destination, {
      recursive: true,
      dereference: true,
      filter: (source) => !['node_modules', 'test', 'tests'].includes(path.basename(source)),
    });
  }

  const release = (await import(
    `${pathToFileURL(path.join(extensionRoot, 'scripts', 'release.mjs')).href}?fixture=${importKey}`
  )) as { buildRelease: () => Promise<void> };
  await release.buildRelease();
  return release.buildRelease;
}
