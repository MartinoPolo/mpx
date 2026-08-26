import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { NodeTransactionStore } from "./transaction.js";

it("cleans an abandoned cross-process lock owned by a nonexistent process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-lock-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "transaction.lock"), JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647 }) + "\n");
  const store = new NodeTransactionStore(root);
  await expect(store.exclusive(async () => "entered")).resolves.toBe("entered");
  await expect(readFile(path.join(root, "transaction.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
