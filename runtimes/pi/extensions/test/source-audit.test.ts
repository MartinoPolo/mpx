import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const auditedExtensions = new Set([".ts", ".mjs", ".ps1", ".json", ".md"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "dist" || entry.name === "node_modules") return [];
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return auditedExtensions.has(extname(entry.name)) ? [target] : [];
  });
}

test("sources contain no external repository or retired native paths", () => {
  const forbidden = [
    new RegExp("[A-Za-z]:[\\\\/][^\\n]*_MP_", "i"),
    new RegExp("\\.codex[\\\\/]", "i"),
    new RegExp("mpx-(?:pi|claude-code)[\\\\/]", "i"),
    /from\s+["'](?:[A-Za-z]:[\\/]|\/(?:home|Users)\/)/,
  ];

  for (const file of sourceFiles(packageRoot)) {
    const contents = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(contents, pattern, `${relative(packageRoot, file)} contains ${pattern}`);
    }
  }
});

test("only the package root owns a package manifest", () => {
  const nested = sourceFiles(packageRoot)
    .filter((file) => file.endsWith("package.json"))
    .map((file) => relative(packageRoot, file));

  assert.deepEqual(nested, ["package.json"]);
});

test("retired and generated resources are excluded", () => {
  const names = sourceFiles(packageRoot).map((file) => relative(packageRoot, file).replaceAll("\\", "/"));
  const forbiddenNames = [
    "mp-namespace-commands.ts",
    "kf-namespace-commands.ts",
    "package-lock.json",
    "credentials.json",
    "nul",
  ];

  for (const name of forbiddenNames) {
    assert.equal(names.some((candidate) => candidate.endsWith(name)), false, name);
  }
});

test("composition entry point does not discover extensions dynamically", () => {
  const entryPoint = readFileSync(join(packageRoot, "index.ts"), "utf8");

  assert.doesNotMatch(entryPoint, /readdir|glob|import\s*\(/);
});
