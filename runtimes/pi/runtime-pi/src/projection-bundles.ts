export const productionBundleFiles = [
  {
    entry: 'production-subagents.ts',
    label: 'production subagent',
    filename: 'production-subagents.mjs',
  },
  {
    entry: 'production-status.ts',
    label: 'production status',
    filename: 'production-status.mjs',
  },
  {
    entry: 'production-runtime.ts',
    label: 'production runtime',
    filename: 'production-runtime.mjs',
  },
  {
    entry: 'launch-private-client.ts',
    label: 'launch-private client',
    filename: 'launch-private-client.mjs',
  },
] as const;

type EmitBundle = (filename: string, content: string) => Promise<void>;
type BundleSource = (entry: string, label: string) => Promise<string>;

export async function emitProductionBundles(
  emit: EmitBundle,
  bundleSource: BundleSource,
): Promise<void> {
  const contents = await Promise.all(
    productionBundleFiles.map(({ entry, label }) => bundleSource(entry, label)),
  );
  for (const [index, { filename }] of productionBundleFiles.entries()) {
    await emit(filename, contents[index]!);
  }
}
