import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createNodeLifecycleFoundation, WorktreeLifecycleService } from "../dist/index.js";

const send = message => process.send?.(message);
const waitFor = type => new Promise(resolve => {
  const listener = message => {
    if (message?.type === type) {
      process.off("message", listener);
      resolve(message);
    }
  };
  process.on("message", listener);
});

send({ type: "ready", pid: process.pid });
const request = await waitFor("go");
const foundation = createNodeLifecycleFoundation(request.stateRoot);
const service = new WorktreeLifecycleService({
  ...foundation,
  configHash: () => "integration-config-hash",
  ports: {
    ensure: async () => {
      await mkdir(request.leaseRoot, { recursive: true });
      const leasePath = `${request.leaseRoot}/lease.json`;
      try {
        await writeFile(leasePath, JSON.stringify({ leaseId: "shared-lease" }), { flag: "wx" });
        await appendFile(`${request.leaseRoot}/mutations.log`, "created\n");
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      return { lease: JSON.parse(await readFile(leasePath, "utf8")) };
    },
    captureReleaseIdentity: async () => { throw new Error("not used"); },
    releaseLinkedAfterRemoval: async () => ({ released: false }),
    reconcile: async () => ({ orphaned: [] }),
  },
  preparation: {
    prepare: async () => ({ status: "ready" }),
    cancel: async () => ({ status: "cancelled" }),
    reconcile: async () => ({ status: "ready" }),
  },
});
try {
  const result = await service.create({ cwd: request.cwd, branch: request.branch, base: "main" });
  send({ type: "done", result });
  process.disconnect?.();
} catch (error) {
  send({ type: "failed", code: error?.code, message: String(error) });
  process.exitCode = 1;
  process.disconnect?.();
}
