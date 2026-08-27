import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readPackage = async relativePath => JSON.parse(await readFile(path.join(root, relativePath), "utf8"));

describe("CLI build preparation", () => {
  it("keeps the CLI package as the only workspace selected by --filter mpx", async () => {
    const [workspace, cli] = await Promise.all([readPackage("package.json"), readPackage("apps/cli/package.json")]);

    expect(cli.name).toBe("mpx");
    expect(workspace.name).not.toBe(cli.name);
  });

  it("builds CLI workspace dependencies before compiling the CLI", async () => {
    const cli = await readPackage("apps/cli/package.json");

    expect(cli.scripts.prebuild).toBe("node ../../scripts/prepare-cli-build.mjs");
  });

  it("uses exact pinned workspace tooling to emit a release-contained CLI bundle", async () => {
    const [workspace, cli] = await Promise.all([readPackage("package.json"), readPackage("apps/cli/package.json")]);

    expect(workspace.devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(cli.scripts.build).toContain("bundle-cli.mjs");
  });
});
