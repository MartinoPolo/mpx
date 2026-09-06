import { cp, mkdir } from 'node:fs/promises';
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

  for (const dependency of ['croner', 'nanoid']) {
    await cp(
      path.join(sourceExtensionRoot, 'node_modules', dependency),
      path.join(extensionRoot, 'node_modules', dependency),
      { recursive: true, dereference: true },
    );
  }

  const compilerDestination = path.join(extensionRoot, 'node_modules', '@mpx', 'content-compiler');
  await mkdir(path.dirname(compilerDestination), { recursive: true });
  await cp(
    path.join(sourceExtensionRoot, 'node_modules', '@mpx', 'content-compiler'),
    compilerDestination,
    {
      recursive: true,
      dereference: true,
      filter: (source) => !['node_modules', 'test', 'tests'].includes(path.basename(source)),
    },
  );

  const release = (await import(
    `${pathToFileURL(path.join(extensionRoot, 'scripts', 'release.mjs')).href}?fixture=${importKey}`
  )) as { buildRelease: () => Promise<void> };
  await release.buildRelease();
  return release.buildRelease;
}
