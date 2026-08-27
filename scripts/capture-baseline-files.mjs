import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readlink, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

function nodeType(value) {
  if (value.isSymbolicLink()) return "symbolic-link";
  if (value.isFile()) return "regular-file";
  if (value.isDirectory()) return "directory";
  return "unsupported";
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs; }
function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function captureFileCandidate({ sourcePath, destinationPath, allowedTargetRoots = [] }) {
  const original = await lstat(sourcePath).catch(error => {
    if (error.code === "ENOENT") throw new Error(`File candidate is missing or dangling: ${sourcePath}`, { cause: error });
    throw error;
  });
  const originalNodeType = nodeType(original);
  if (originalNodeType !== "regular-file" && originalNodeType !== "symbolic-link") throw new Error(`Unsupported file candidate node (${originalNodeType}): ${sourcePath}`);

  let rawTarget;
  let resolvedTarget = sourcePath;
  if (originalNodeType === "symbolic-link") {
    rawTarget = await readlink(sourcePath);
    try { resolvedTarget = await realpath(sourcePath); }
    catch (error) { throw new Error(`File candidate is missing or dangling: ${sourcePath}`, { cause: error }); }
    if (!allowedTargetRoots.some(root => inside(root, resolvedTarget))) throw new Error(`Symlink target is outside the candidate-specific allowlist: ${sourcePath}`);
  }

  const handle = await open(resolvedTarget, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Symlink target is not a regular file: ${sourcePath}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const [currentOriginal, currentTarget] = await Promise.all([lstat(sourcePath), stat(resolvedTarget)]);
    if (!sameIdentity(before, after) || !sameIdentity(before, currentTarget) || !sameIdentity(original, currentOriginal)) throw new Error(`File candidate changed during capture: ${sourcePath}`);
    if (originalNodeType === "symbolic-link" && await realpath(sourcePath) !== resolvedTarget) throw new Error(`Symlink target changed during capture: ${sourcePath}`);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, bytes, { flag: "wx" });
    return {
      sourcePath, destinationPath, originalNodeType, capturedNodeType: "regular-file",
      ...(rawTarget === undefined ? {} : { rawTarget, resolvedTarget }),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally { await handle.close(); }
}

export async function inventoryDirectory(root, relative = "") {
  const entries = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const childRelative = path.join(relative, name), child = path.join(root, childRelative), info = await lstat(child);
    const type = nodeType(info), record = { path: childRelative, nodeType: type };
    if (type === "symbolic-link") {
      record.rawTarget = await readlink(child);
      if (!sameIdentity(info, await lstat(child)) || record.rawTarget !== await readlink(child)) throw new Error(`Nested link changed during inventory: ${child}`);
    } else if (type === "regular-file") {
      const handle = await open(child, constants.O_RDONLY);
      try {
        const before = await handle.stat(), bytes = await handle.readFile(), after = await handle.stat();
        if (!sameIdentity(before, after) || !sameIdentity(before, await stat(child)) || !sameIdentity(info, await lstat(child))) throw new Error(`Nested file changed during inventory: ${child}`);
        record.size = bytes.length;
        record.sha256 = createHash("sha256").update(bytes).digest("hex");
      } finally { await handle.close(); }
    }
    entries.push(record);
    if (type === "directory") entries.push(...await inventoryDirectory(root, childRelative));
    else if (type !== "regular-file" && type !== "symbolic-link") throw new Error(`Unsupported nested node (${type}): ${child}`);
  }
  return entries;
}

export function inventoriesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function captureDirectoryCandidate({ sourcePath, destinationPath }) {
  const info = await lstat(sourcePath);
  const type = nodeType(info);
  if (type === "symbolic-link") throw new Error(`Top-level directory candidate is a link and will not be followed: ${sourcePath}`);
  if (type === "regular-file") return captureFileCandidate({ sourcePath, destinationPath });
  if (type !== "directory") throw new Error(`Unsupported directory candidate node (${type}): ${sourcePath}`);
  const entries = await inventoryDirectory(sourcePath);
  if (!sameIdentity(info, await lstat(sourcePath))) throw new Error(`Directory candidate changed during capture: ${sourcePath}`);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  const [sourceAfter, destinationEntries] = await Promise.all([inventoryDirectory(sourcePath), inventoryDirectory(destinationPath)]);
  if (!sameIdentity(info, await lstat(sourcePath)) || !inventoriesEqual(entries, sourceAfter)) throw new Error(`Directory candidate changed during capture: ${sourcePath}`);
  if (!inventoriesEqual(entries, destinationEntries)) throw new Error(`Directory restore inventory mismatch: ${sourcePath}`);
  return { sourcePath, destinationPath, originalNodeType: "directory", capturedNodeType: "directory", entries };
}
