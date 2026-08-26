import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("reports an uninstalled machine from mpx install verify in each fresh process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-install-fresh-"));
  const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const env = { ...process.env, MPX_APPS: path.join(root, "apps"), APPDATA: path.join(root, "roaming"), LOCALAPPDATA: path.join(root, "local"), USERPROFILE: path.join(root, "user") };
  for (let processIndex = 0; processIndex < 2; processIndex++) {
    const { stdout, stderr } = await execute(process.execPath, [entry, "--json", "install", "verify"], { env, windowsHide: true });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { schemaVersion: 1, kind: "install-verification", healthy: false, issues: ["receipt-missing"] } });
  }
}, 30_000);
