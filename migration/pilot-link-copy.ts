import { cp, lstat, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function replaceDirectoryLink(directory: string, expectedTarget: string, snapshot: string): Promise<string> {
  const preserved = `${directory}.mpx2-original-link`;
  const prepared = `${directory}.mpx2-private-copy`;
  if (await lstat(preserved).catch(() => undefined) || await lstat(prepared).catch(() => undefined)) throw new Error('Pilot directory staging paths already exist.');
  if (!(await lstat(directory)).isSymbolicLink() || await readlink(directory) !== expectedTarget) throw new Error('Pilot directory link changed.');
  try {
    await cp(snapshot, prepared, { recursive: true, force: false, errorOnExist: true });
    if (!(await lstat(directory)).isSymbolicLink() || await readlink(directory) !== expectedTarget) throw new Error('Pilot directory link changed during preparation.');
    await rename(directory, preserved);
    try { await rename(prepared, directory); }
    catch (error) { await rename(preserved, directory); throw error; }
  } finally { await rm(prepared, { recursive: true, force: true }); }
  return preserved;
}

export async function replaceVerifiedLink(file: string, expectedTarget: string, bytes: Buffer): Promise<void> {
  let directory = path.dirname(file);
  for (;;) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Pilot link has an unsafe parent.');
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const verify = async () => {
    if (!(await lstat(file)).isSymbolicLink() || await readlink(file) !== expectedTarget || !bytes.equals(await readFile(file))) throw new Error('Pilot link or its source changed before replacement.');
  };
  await verify();
  const temporary = `${file}.mpx2-private-copy.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await verify();
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
